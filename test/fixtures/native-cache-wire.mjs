/** Exact running Linux cli-node against synthetic loopback SSE. No live auth. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import crypto from 'node:crypto'

assert.deepEqual(fs.readdirSync('/sys/class/net').sort(), ['lo'], 'Run with --network=none')
const cli = process.env.TTL_FIXTURE_CLI
const kernel = process.env.TTL_FIXTURE_KERNEL
const cases = JSON.parse(fs.readFileSync(process.env.TTL_FIXTURE_CASES, 'utf8'))
const ttlOnly = process.env.TTL_FIXTURE_ONLY === '1'
const calls = []
const usage = { input_tokens: 11, output_tokens: 0, cache_creation_input_tokens: 5,
  cache_read_input_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 } }
const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/v1/messages')) return res.writeHead(403).end()
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  calls.push(body)
  const events = [
    { type: 'message_start', message: { id: `msg_fixture_${calls.length}`, type: 'message',
      role: 'assistant', model: body.model, content: [], stop_reason: null, usage } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SYNTHETIC' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const home = '/tmp/native-cache-fixture'
fs.mkdirSync(home)
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: home,
  ANTHROPIC_API_KEY: 'offline-fixture-only', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  CLAUDE_CODE_NATIVE_SLOTS: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', NO_PROXY: '127.0.0.1,localhost' }
const socketPath = home + '/kernel.sock'
if (kernel) {
  fs.writeFileSync(home + '/credentials.json', JSON.stringify({ anthropicApiKey: { apiKey: 'offline-fixture-only' } }))
  fs.writeFileSync(home + '/kernel.json', JSON.stringify({ vm_id: 'fixture', socket_path: socketPath,
    credential_path: home + '/credentials.json', internal_token: 'fixture-token', provider: 'local_cli',
    claude_bin: cli, slots_per_worker: 1, system_layout: 'identity', timezone: 'UTC',
    default_cache_ttl: '1h', test_endpoints: true, anthropic_base_url: env.ANTHROPIC_BASE_URL }))
}
const child = spawn(kernel || cli, kernel ? ['--gateway-worker', '--config', home + '/kernel.json'] : [],
  { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] })
let slot, current = -1, active = false, text = '', stderr = ''
const frames = []
child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-1200) })
const completed = kernel ? (async () => {
  for (let i = 0; i < 250 && !fs.existsSync(socketPath) && child.exitCode == null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(fs.existsSync(socketPath), stderr)
  for (const body of cases) {
    await new Promise((resolve, reject) => {
      const req = http.request({ socketPath, path: '/internal/v1/messages', method: 'POST',
        headers: { 'x-internal-token': 'fixture-token', 'content-type': 'application/json' }, timeout: 15000 }, (res) => {
        let raw = ''
        res.on('data', (chunk) => { raw += chunk })
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`Kernel ${res.statusCode}: ${raw}`))
          for (const line of raw.split('\n')) if (line.startsWith('data: ')) {
            frames.push({ type: 'stream_event', event: JSON.parse(line.slice(6)) })
          }
          resolve()
        })
      })
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error('Kernel fixture timeout')))
      req.end(JSON.stringify({ body, stream: true, headers: {}, cache_ttl: null,
        preserve_cache_breakpoints: true, request_id: crypto.randomUUID() }))
    })
  }
})() : new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Fixture timeout: ' + stderr)), 25000)
  child.once('error', reject)
  child.once('exit', (code) => { if (current < cases.length - 1 || active) reject(new Error(`CLI exit ${code}: ${stderr}`)) })
  function send() {
    if (active || slot === undefined || current >= cases.length - 1) return
    active = true
    current++
    child.stdin.write(JSON.stringify({ type: 'job_start', job_id: `cache-${current}`, slot_id: slot,
      request: cases[current] }) + '\n')
  }
  child.stdout.on('data', (chunk) => {
    text += chunk
    let end
    while ((end = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, end)
      text = text.slice(end + 1)
      let frame
      try { frame = JSON.parse(line) } catch { continue }
      frames.push(frame)
      if (frame.type === 'slot_ready') { slot = frame.slot_id; send() }
      if (frame.type === 'job_error') { clearTimeout(timer); reject(new Error(JSON.stringify(frame))); return }
      if (frame.type === 'job_done') {
        active = false
        if (current === cases.length - 1) { clearTimeout(timer); resolve(); return }
        queueMicrotask(send)
      }
    }
  })
})
let receipt
function cacheNodes(body) {
  return [body, ...(body.system || []), ...(body.tools || []),
    ...body.messages.flatMap((m) => Array.isArray(m.content) ? m.content : [])]
    .filter((n) => n?.cache_control?.type === 'ephemeral')
}
function withoutTtl(body) {
  const out = structuredClone(body)
  for (const node of cacheNodes(out)) delete node.cache_control.ttl
  for (const block of out.system || []) {
    if (block.text?.startsWith('x-anthropic-billing-header:')) block.text = block.text.replace(/cch=[a-f0-9]+;/, 'cch=CHECKSUM;')
  }
  return out
}
try {
  await completed
  assert.equal(calls.length, cases.length)
  const checks = []
  for (let i = 0; i < cases.length; i++) {
    const actual = calls[i], expected = cases[i]
    if (ttlOnly) {
      const requested = new Set(cacheNodes(expected).map((n) => n.cache_control.ttl || '5m'))
      assert.equal(requested.size, 1)
      const ttl = [...requested][0]
      const actualPoints = cacheNodes(actual)
      assert.ok(actualPoints.length)
      assert.ok(actualPoints.every((n) => (n.cache_control.ttl || '5m') === ttl), `actual TTL ${i}`)
      assert.deepEqual(withoutTtl(actual), withoutTtl(calls[0]), `native context ${i}`)
      checks.push({ index: i, native_ttl: ttl, points: actualPoints.length, context_unchanged: true })
      continue
    }
    assert.deepEqual(actual.messages, expected.messages, `messages ${i}`)
    assert.deepEqual(actual.tools, expected.tools, `tools ${i}`)
    // Runtime billing block belongs to CLI; caller blocks must retain order/data.
    const system = actual.system.filter((b) => !b.text?.startsWith('x-anthropic-billing-header:'))
    const caller = expected.system.filter((b) => !b.text?.startsWith('x-anthropic-billing-header:'))
    assert.deepEqual(system.slice(-caller.length), caller, `caller system ${i}`)
    const prefix = system.slice(0, -caller.length)
    assert.ok(prefix.every((b) => b.text === "You are a Claude agent, built on Anthropic's Claude Agent SDK."))
    checks.push({ index: i, system: true, tools: true, messages: true, native_prefix: prefix })
  }
  const starts = frames.filter((f) => f.type === 'stream_event' && f.event.type === 'message_start')
  assert.equal(starts.length, cases.length)
  for (const f of starts) assert.deepEqual(f.event.message.usage, usage)
  receipt = { ok: true, checks, fixture_calls: calls.length, real_provider_calls: 0, via_kernel: !!kernel,
    cli_sha256: crypto.createHash('sha256').update(fs.readFileSync(cli)).digest('hex'),
    raw_usage_preserved: true, same_slot_jobs: cases.length }
} catch (error) {
  receipt = { ok: false, error: String(error), fixture_calls: calls.length, real_provider_calls: 0,
    frames: frames.map((f) => ({ type: f.type, version: f.version, status: f.status, code: f.code })),
    // All requests in this file are synthetic and contain no real identifiers.
    synthetic_wire: calls }
  process.exitCode = 1
} finally {
  child.kill('SIGKILL')
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
console.log(JSON.stringify(receipt))

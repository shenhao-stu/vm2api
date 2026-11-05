import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { createRespond, readBody } from '../../src/lib/http/respond.mjs'
import { rememberRustHealth, clearRustHealthCache } from '../../src/lib/transport/kernel-router.mjs'
import { listCacheMarkers, forceEphemeralCacheTtl } from '../../src/lib/protocol/cache-ttl.mjs'

const usage = {
  input_tokens: 11,
  output_tokens: 3,
  cache_read_input_tokens: 7,
  cache_creation_input_tokens: 5,
  cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 },
}

async function harness(t, passthrough = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cache-handler-'))
  const socketPath = path.join(root, 'kernel.sock')
  const tokenPath = path.join(root, 'internal.token')
  fs.writeFileSync(tokenPath, 'fixture-token')
  const binary = path.join(root, 'fixture-kernel')
  fs.writeFileSync(binary, 'not executed; worker boundary is the fixture socket', { mode: 0o700 })
  const oldKernel = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = binary
  const captured = []
  const kernel = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    assert.equal(req.headers['x-internal-token'], 'fixture-token')
    assert.equal(req.url, '/internal/v1/messages')
    const envelope = JSON.parse(raw)
    captured.push(envelope)
    const message = {
      type: 'message',
      role: 'assistant',
      model: envelope.body.model,
      id: 'msg_fixture',
      content: [],
      stop_reason: null,
      usage: { ...usage, output_tokens: 0 },
    }
    const events = [
      { type: 'message_start', message },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  await new Promise((resolve) => kernel.listen(socketPath, resolve))
  const vm = {
    id: 'vm-fixture',
    claude: { mode: 'api-key' },
    runtime: {
      kernel_socket: socketPath,
      worker_token_file: tokenPath,
      worker_run_dir: root,
    },
  }
  const exec = { vmId: vm.id, vm, homeDir: path.join(root, 'home'), oauth: {}, timezone: 'UTC' }
  fs.mkdirSync(exec.homeDir)
  const routing = {
    inference: { engine: 'rust', health_ttl_ms: 60000 },
    compatibility: { official_cc_passthrough: passthrough },
    failover: { stream_keepalive_ms: 0 },
  }
  const routingPath = path.join(root, 'routing.json')
  fs.writeFileSync(routingPath, JSON.stringify(routing))
  rememberRustHealth(exec, { ok: true, health: { ok: true, ready_slots: 1, healthy: true } })
  const logs = []
  const cfg = {
    rewrite: { enabled: false },
    intercept: { rules: [] },
    distill: { enabled: false },
    limits: { max_body_bytes: 1048576, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
    paths: { project: root, data: root },
  }
  let scheduled = 0
  const handler = createHandleProtocol({
    ...createRespond(cfg),
    readBody,
    cfg,
    requireAuth: () => true,
    requestLog: { start: () => ({ request_id: 'fixture', t0: Date.now() }), finish: (_ctx, bag) => logs.push(bag) },
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    groupsRepo: { rateMultiplier: () => 1 },
    routingConfigPath: routingPath,
    routingConfig: routing,
    apiKeyStore: {},
    accountQuota: {},
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    failoverRunner: {
      async run(opts) {
        scheduled++
        const candidate = { vmId: vm.id, accountId: 'fixture-account', vm, exec }
        const prepared = await opts.applyAttempt(opts.canonicalBody, candidate)
        return opts.callAttempt({
          candidate,
          body: prepared.body,
          attemptMeta: prepared.meta,
          signal: opts.signal,
          deliveryMode: opts.deliveryMode,
          onCommit() {},
        })
      },
    },
  })
  const gateway = http.createServer((req, res) => {
    req.apiKeyKind = 'master'
    handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages').catch((error) => {
      res.writeHead(500).end(String(error.stack))
    })
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    gateway.closeAllConnections()
    kernel.closeAllConnections()
    await Promise.all([
      new Promise((resolve) => gateway.close(resolve)),
      new Promise((resolve) => kernel.close(resolve)),
    ])
    clearRustHealthCache(vm.id)
    if (oldKernel === undefined) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = oldKernel
    fs.rmSync(root, { recursive: true, force: true })
  })
  const send = async (body) => {
    const response = await fetch(`http://127.0.0.1:${gateway.address().port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'claude-cli/2.1.304 (external, sdk-cli)' },
      body: JSON.stringify(body),
    })
    return { status: response.status, text: await response.text() }
  }
  return { send, captured, logs, scheduled: () => scheduled }
}

test('passthrough retains homogeneous TTL, mid-system, tools and original usage', async (t) => {
  const h = await harness(t)
  const input = {
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    stream: false,
    metadata: {
      user_id: JSON.stringify({
        device_id: 'a'.repeat(64),
        account_uuid: '',
        session_id: '11111111-2222-4333-8444-555555555555',
      }),
    },
    system: [
      {
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: 'caller',
        eager_input_streaming: false,
        input_schema: { type: 'object', properties: { cache_control: { type: 'string' } } },
      },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'old' }] },
      { role: 'system', content: [{ type: 'text', text: 'mid-system' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_fixture', name: 'caller', input: { cache_control: 'business' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_fixture',
            content: 'result',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      },
    ],
  }
  const expected = structuredClone(input)
  expected.system[0].cache_control.ttl = '1h'
  const result = await h.send(input)
  assert.equal(result.status, 200, result.text)
  assert.equal(h.captured.length, 1)
  const envelope = h.captured[0]
  assert.deepEqual(envelope.body.messages, expected.messages)
  assert.deepEqual(envelope.body.system, expected.system)
  assert.deepEqual(envelope.body.tools, expected.tools)
  assert.equal(envelope.preserve_cache_breakpoints, true)
  assert.equal(envelope.cache_ttl, null)
  assert.deepEqual(JSON.parse(result.text).usage, usage)

  // Same caller session: an old request's resolved TTL cannot override this one.
  const next = structuredClone(input)
  next.system[0].cache_control.ttl = '5m'
  next.messages.at(-1).content[0].cache_control.ttl = '5m'
  assert.equal((await h.send(next)).status, 200)
  assert.equal(h.captured[1].body.messages.at(-1).content[0].cache_control.ttl, '5m')
  assert.deepEqual(h.logs.at(-1).usage.cache_creation, usage.cache_creation)
})

test('native handler rejects mixed TTL before scheduling or worker calls', async (t) => {
  const h = await harness(t)
  const result = await h.send({
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    metadata: {
      user_id: JSON.stringify({
        device_id: 'a'.repeat(64),
        account_uuid: '',
        session_id: '11111111-2222-4333-8444-555555555555',
      }),
    },
    system: [
      {
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: 'ephemeral', ttl: '5m' },
      },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'tail', cache_control: { type: 'ephemeral' } }] }],
  })
  assert.equal(result.status, 400, result.text)
  assert.equal(JSON.parse(result.text).error.code, 'cache_ttl_mixed_unsupported')
  assert.equal(h.scheduled(), 0)
  assert.deepEqual(h.captured, [])
})

test('existing rewrite context and marker layout stay unchanged across native per-turn TTL changes', async (t) => {
  const h = await harness(t, false)
  const input = {
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    metadata: {
      user_id: JSON.stringify({
        device_id: 'a'.repeat(64),
        account_uuid: '',
        session_id: '11111111-2222-4333-8444-555555555555',
      }),
    },
    system: [{ type: 'text', text: 'FIXTURE_CALLER_SYSTEM' }],
    tools: [
      {
        name: 'caller',
        eager_input_streaming: false,
        input_schema: { type: 'object', properties: { cache_control: { type: 'string' } } },
      },
    ],
    messages: [{ role: 'user', content: 'fixture user' }],
  }
  for (const ttl of [undefined, '5m', '1h']) {
    const request = { ...input, ...(ttl ? { cache_control: { type: 'ephemeral', ttl } } : {}) }
    const result = await h.send(request)
    assert.equal(result.status, 200, result.text)
    const envelope = h.captured.at(-1)
    const points = listCacheMarkers(envelope.body)
    assert.ok(points.length)
    assert.ok(points.every((p) => p.ttl === (ttl || '1h')))
    assert.deepEqual(JSON.parse(result.text).usage, usage)
    assert.equal(envelope.cache_ttl, null)
    assert.equal(envelope.preserve_cache_breakpoints, true)
  }
  const context = (body) => {
    const value = forceEphemeralCacheTtl(body, '1h')
    return { ...value, betas: value.betas.filter((b) => b !== 'extended-cache-ttl-2025-04-11') }
  }
  for (const envelope of h.captured.slice(1)) {
    assert.deepEqual(context(envelope.body), context(h.captured[0].body))
  }
  if (process.env.NATIVE_CACHE_FIXTURE_OUTPUT) {
    fs.writeFileSync(
      process.env.NATIVE_CACHE_FIXTURE_OUTPUT,
      JSON.stringify(
        h.captured.map((envelope) => envelope.body),
        null,
        2,
      ),
    )
  }
  const count = h.captured.length
  const result = await h.send({
    ...input,
    cache_control: { type: 'ephemeral', ttl: '5m' },
    system: [{ type: 'text', text: 'fixture', cache_control: { type: 'ephemeral' } }],
  })
  assert.equal(result.status, 400, result.text)
  assert.equal(JSON.parse(result.text).error.code, 'cache_ttl_mixed_unsupported')
  assert.equal(h.captured.length, count)
})

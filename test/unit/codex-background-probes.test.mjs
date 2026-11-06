import { tryAcquireOpenAISlot } from '../../src/lib/pool/openai-account-runtime.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  listTestableModels,
  resolveTestModels,
  runVmTestChat,
  syncCodexCatalog,
  testChatCredentialMode,
} from '../../src/lib/admin/vm-test-chat.mjs'
import { readCodexAccounts, upsertCodexAccount } from '../../src/lib/vm/codex-slot.mjs'
import { getGptModelPolicy } from '../../src/lib/protocol/gpt-model-policy.mjs'
import { withVmLock } from '../../src/lib/vm/vm-file.mjs'

function seedCodexVm(root, id = 'vm-codex-01') {
  const vms = path.join(root, 'vms')
  fs.mkdirSync(path.join(vms, id), { recursive: true })
  fs.writeFileSync(
    path.join(vms, `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      status: 'running',
      schedulable: true,
      platform: 'openai',
      family: 'codex',
      proxy_cli_enabled: true,
      proxy: { id: `proxy-${id}`, url: 'socks5h://127.0.0.1:1080', host: '127.0.0.1', port: 1080 },
      codex: { has_access: true },
    }),
  )
  fs.writeFileSync(
    path.join(vms, id, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [
        { access_token: 'codex-access', refresh_token: 'codex-refresh', chatgpt_account_id: 'fixture-codex-account' },
      ],
    }),
  )
}

function seedRouting(root) {
  const configDir = path.join(root, 'src', 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'routing.json'), JSON.stringify({}))
}

async function startLoopbackServer(t, respond) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    calls.push({
      url: `http://${req.headers.host}${req.url}`,
      headers: req.headers,
      body,
    })
    const reply = respond()
    res.writeHead(reply.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(reply.body))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, calls }
}

test('owner-managed probes do not rotate credentials after direct or wrapped 401', async (t) => {
  for (const status of [401, 502]) {
    await t.test(`HTTP ${status}`, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-quality-no-refresh-'))
      t.after(() => fs.rmSync(root, { recursive: true, force: true }))
      seedCodexVm(root)
      seedRouting(root)
      const credentialFile = path.join(root, 'vms', 'vm-codex-01', 'codex-credentials.json')
      const before = fs.readFileSync(credentialFile, 'utf8')
      const { baseUrl, calls } = await startLoopbackServer(t, () => ({
        status,
        body: { error: { code: 'upstream_transport', message: 'HTTP error: 401 Unauthorized' } },
      }))
      let refreshCalls = 0
      const result = await runVmTestChat({
        projectRoot: root,
        vmId: 'vm-codex-01',
        model: 'gpt-5.4',
        prompt: 'hello',
        baseUrl,
        apiKey: 'test-master-key',
        allowCredentialRefresh: false,
        fetchImpl: async () => {
          refreshCalls++
          throw new Error('quality probe must not refresh credentials')
        },
      })
      assert.equal(result.ok, false)
      assert.equal(calls.length, 1)
      assert.equal(refreshCalls, 0)
      assert.equal(fs.readFileSync(credentialFile, 'utf8'), before)
    })
  }
})

function catalogFixture(t, count) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-discovery-codex-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (let i = 0; i < count; i++) {
    const id = `vm-catalog-${String(i).padStart(2, '0')}`
    seedCodexVm(root, id)
    fs.writeFileSync(
      path.join(root, 'vms', id, 'codex-credentials.json'),
      JSON.stringify({
        accounts: [{ access_token: `catalog-at-${id}`, refresh_token: 'do-not-refresh', chatgpt_account_id: id }],
      }),
    )
  }
  return root
}

function catalogReply(id) {
  return { ok: true, status: 200, json: async () => ({ models: [{ slug: `gpt-catalog-${id}` }] }) }
}

test('background discovery unions three accounts and rotates through the other healthy slots', async (t) => {
  const root = catalogFixture(t, 6)
  const seen = []
  const opts = {
    projectRoot: root,
    rotate: false,
    catalogClientVersion: '0.164.0',
    fetchImpl: async (url, init) => {
      assert.ok(String(url).includes('/codex/models?'))
      seen.push(init.headers['chatgpt-account-id'])
      return catalogReply(init.headers['chatgpt-account-id'])
    },
  }
  const first = await syncCodexCatalog(opts)
  assert.equal(first.successful_accounts, 3)
  assert.equal(first.attempted_accounts, 3)
  assert.equal(first.ids.length, 3)
  assert.equal(first.partial, true)
  const second = await syncCodexCatalog(opts)
  assert.equal(second.successful_accounts, 3)
  assert.equal(new Set(seen).size, 6)
  for (const id of [...first.ids, ...second.ids]) assert.ok(getGptModelPolicy().models[id])
})

test('background failure stops at six attempts, never refreshes, and keeps the last catalog', async (t) => {
  const root = catalogFixture(t, 10)
  const before = structuredClone(getGptModelPolicy())
  const file = path.join(root, 'vms', 'vm-catalog-00', 'codex-credentials.json')
  const beforeCredential = fs.readFileSync(file, 'utf8')
  let calls = 0
  const result = await syncCodexCatalog({
    projectRoot: root,
    rotate: false,
    catalogClientVersion: '0.164.0',
    fetchImpl: async (url) => {
      assert.ok(String(url).includes('/codex/models?'))
      calls++
      return { status: 401, json: async () => ({}) }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.attempted_accounts, 6)
  assert.equal(result.failed_accounts, 6)
  assert.equal(calls, 6)
  assert.deepEqual(getGptModelPolicy(), before)
  assert.equal(fs.readFileSync(file, 'utf8'), beforeCredential)
})

test('a failed account does not prevent discovery through the next accounts', async (t) => {
  const root = catalogFixture(t, 5)
  let calls = 0
  const result = await syncCodexCatalog({
    projectRoot: root,
    rotate: false,
    catalogClientVersion: '0.164.0',
    fetchImpl: async (_url, init) => {
      calls++
      if (calls <= 2) return { status: calls === 1 ? 401 : 503, json: async () => ({}) }
      return catalogReply(init.headers['chatgpt-account-id'])
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.successful_accounts, 3)
  assert.equal(result.failed_accounts, 2)
  assert.equal(result.attempted_accounts, 5)
  assert.equal(result.ids.length, 3)
})

test('automatic discovery skips manual off, quarantined, held and stopped slots', async (t) => {
  const root = catalogFixture(t, 7)
  const changes = [
    { schedule_off: true },
    { unschedulable: { reason: 'oauth_revoked' } },
    { schedule_hold: { reason: 'proxy_cooldown' } },
    { status: 'stopped' },
  ]
  for (const [index, patch] of changes.entries()) {
    const file = path.join(root, 'vms', `vm-catalog-0${index}.json`)
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), ...patch }))
  }
  const seen = []
  const result = await syncCodexCatalog({
    projectRoot: root,
    rotate: false,
    catalogClientVersion: '0.164.0',
    fetchImpl: async (_url, init) => {
      seen.push(init.headers['chatgpt-account-id'])
      return catalogReply(init.headers['chatgpt-account-id'])
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(seen, ['vm-catalog-04', 'vm-catalog-05', 'vm-catalog-06'])
})

test('invalid explicit VM never falls back to the rest of the account pool', async (t) => {
  const root = catalogFixture(t, 1)
  let calls = 0
  for (const vmId of ['missing', '../escape']) {
    const result = await syncCodexCatalog({
      projectRoot: root,
      vmId,
      rotate: false,
      catalogClientVersion: '0.164.0',
      fetchImpl: async () => {
        calls++
        return catalogReply('unexpected')
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no_codex_slot')
  }
  assert.equal(calls, 0)
})

test('overlapping catalog scans share one flight and conflicting targets return busy', async (t) => {
  const root = catalogFixture(t, 1)
  let release
  let started
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const ready = new Promise((resolve) => {
    started = resolve
  })
  let calls = 0
  const opts = {
    projectRoot: root,
    rotate: false,
    catalogClientVersion: '0.164.0',
    fetchImpl: async () => {
      calls++
      started()
      await gate
      return catalogReply('single-flight')
    },
  }
  const first = syncCodexCatalog(opts)
  await ready
  const second = syncCodexCatalog(opts)
  assert.equal(first, second)
  const busy = await syncCodexCatalog({ ...opts, vmId: 'vm-catalog-00' })
  assert.equal(busy.error, 'catalog_sync_busy')
  release()
  assert.equal((await first).ok, true)
  assert.equal((await second).ok, true)
  assert.equal(calls, 1)
})

test('late catalog body completion after a deadline cannot publish a model', async (t) => {
  const root = catalogFixture(t, 1)
  let release
  const late = new Promise((resolve) => {
    release = resolve
  })
  let signal
  const result = await syncCodexCatalog({
    projectRoot: root,
    rotate: false,
    catalogClientVersion: '0.164.0',
    requestTimeoutMs: 10,
    fetchImpl: async (_url, init) => {
      signal = init.signal
      return { status: 200, json: () => late }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'timeout')
  assert.equal(signal.aborted, true)
  release({ models: [{ slug: 'gpt-late-expired-catalog' }] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(getGptModelPolicy().models['gpt-late-expired-catalog'], undefined)
})

test('the overall discovery budget stops further accounts after elapsed response time', async (t) => {
  const root = catalogFixture(t, 10)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const result = await syncCodexCatalog({
    projectRoot: root,
    rotate: false,
    catalogClientVersion: '0.164.0',
    budgetMs: 30,
    requestTimeoutMs: 12,
    fetchImpl: async () => {
      now += 12
      return { status: 503, json: async () => ({}) }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'timeout')
  assert.equal(result.attempted_accounts, 3)
})

test('a stalled refresh body releases the catalog flight and late tokens never write', async (t) => {
  const root = catalogFixture(t, 1)
  const file = path.join(root, 'vms', 'vm-catalog-00', 'codex-credentials.json')
  const before = fs.readFileSync(file, 'utf8')
  let finishBody
  const body = new Promise((resolve) => {
    finishBody = resolve
  })
  let refreshSignal
  let modelGets = 0
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/oauth/token')) {
      refreshSignal = init.signal
      return { status: 200, json: () => body }
    }
    modelGets++
    return modelGets === 1 ? { status: 401, json: async () => ({}) } : catalogReply('after-refresh-timeout')
  }
  const result = await syncCodexCatalog({
    projectRoot: root,
    rotate: true,
    catalogClientVersion: '0.164.0',
    budgetMs: 30,
    requestTimeoutMs: 100,
    fetchImpl,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'timeout')
  assert.equal(refreshSignal.aborted, true)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  const retry = await syncCodexCatalog({ projectRoot: root, rotate: false, catalogClientVersion: '0.164.0', fetchImpl })
  assert.equal(retry.ok, true)
  finishBody({ access_token: 'late-new-at', refresh_token: 'late-new-rt' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.equal(modelGets, 2)
})

test('a refresh waiting for the VM lock expires without writing after the lock is released', async (t) => {
  const root = catalogFixture(t, 1)
  const vmFile = path.join(root, 'vms', 'vm-catalog-00.json')
  const file = path.join(root, 'vms', 'vm-catalog-00', 'codex-credentials.json')
  const before = fs.readFileSync(file, 'utf8')
  let releaseLock
  let enteredLock
  const gate = new Promise((resolve) => {
    releaseLock = resolve
  })
  const entered = new Promise((resolve) => {
    enteredLock = resolve
  })
  const lock = withVmLock(vmFile, async () => {
    enteredLock()
    await gate
  })
  t.after(() => releaseLock())
  await entered
  let modelGets = 0
  const fetchImpl = async (url) => {
    if (String(url).includes('/oauth/token')) {
      return { status: 200, json: async () => ({ access_token: 'queued-new-at', refresh_token: 'queued-new-rt' }) }
    }
    modelGets++
    return modelGets === 1 ? { status: 401, json: async () => ({}) } : catalogReply('after-lock-timeout')
  }
  const result = await syncCodexCatalog({
    projectRoot: root,
    rotate: true,
    catalogClientVersion: '0.164.0',
    budgetMs: 30,
    requestTimeoutMs: 100,
    fetchImpl,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'timeout')
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  const retry = await syncCodexCatalog({ projectRoot: root, rotate: false, catalogClientVersion: '0.164.0', fetchImpl })
  assert.equal(retry.ok, true)
  releaseLock()
  await lock
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.equal(modelGets, 2)
})

// Streams a real loopback HTTP reply. `frames` are written one by one so the
// SSE parser exercises incremental buffering, exactly like a live upstream.
// `destroy` resets the socket after the frames (mid-stream upstream death) and
// `hold` leaves the response open so the client side times out on its own.
async function startScriptedLoopbackServer(t, respond) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    calls.push({ url: `http://${req.headers.host}${req.url}`, headers: req.headers, body })
    const reply = respond()
    res.writeHead(reply.status, reply.headers || { 'content-type': 'application/json' })
    if (Array.isArray(reply.frames)) {
      for (const frame of reply.frames) {
        res.write(frame)
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
    } else if (reply.body !== undefined) {
      res.write(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body))
    }
    if (reply.destroy) {
      // Give the client time to consume the frames, then reset the connection
      // without ever terminating the SSE stream.
      await new Promise((resolve) => setTimeout(resolve, 25))
      res.destroy()
      return
    }
    if (reply.hold) return
    res.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, calls }
}

function sseFrame(event) {
  return `data: ${JSON.stringify(event)}\n\n`
}

const SAFETY_CONFIG_HEADERS = {
  'content-type': 'text/event-stream',
  'x-codex-safety-buffering-enabled': 'true',
  'x-codex-safety-buffering-faster-model': 'gpt-6-luna',
}

const SAFETY_METADATA_EVENT = {
  type: 'codex.response.metadata',
  headers: {
    'x-codex-safety-buffering-enabled': 'true',
    'x-codex-safety-buffering-faster-model': 'gpt-6-luna',
  },
}

async function runSafetyProbe(
  t,
  { headers = SAFETY_CONFIG_HEADERS, frames, destroy = false, hold = false, timeoutMs } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-testchat-safety-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedCodexVm(root)
  seedRouting(root)
  const { baseUrl } = await startScriptedLoopbackServer(t, () => ({ status: 200, headers, frames, destroy, hold }))
  return runVmTestChat({
    projectRoot: root,
    vmId: 'vm-codex-01',
    model: 'gpt-5.4',
    prompt: 'hello',
    max_tokens: 16,
    baseUrl,
    apiKey: 'test-master-key',
    timeoutMs,
  })
}

test('safety telemetry keeps an upstream true flag and the real response model', async (t) => {
  const result = await runSafetyProbe(t, {
    frames: [
      sseFrame(SAFETY_METADATA_EVENT),
      sseFrame({
        type: 'response.created',
        safety_buffering: true,
        response: { id: 'resp_live', model: 'gpt-5.4-2026-01-01', status: 'in_progress' },
      }),
      sseFrame({ type: 'response.in_progress', safety_buffering: true }),
      sseFrame({ type: 'response.output_text.delta', safety_buffering: true, delta: 'safe hi' }),
      sseFrame({
        type: 'response.completed',
        safety_buffering: true,
        response: {
          id: 'resp_live',
          model: 'gpt-5.4-2026-01-01',
          status: 'completed',
          usage: { input_tokens: 5, output_tokens: 2 },
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'safe hi' }] }],
        },
      }),
    ],
  })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'safe hi')
  assert.equal(result.debug.safety_buffering, true)
  assert.equal(result.debug.safety_buffering_enabled, 'true')
  assert.equal(result.debug.safety_buffering_faster_model, 'gpt-6-luna')
  assert.equal(result.debug.upstream_model, 'gpt-5.4-2026-01-01')
  assert.notEqual(result.debug.upstream_model, 'gpt-5.4')
})

test('safety telemetry keeps an upstream false flag without turning config into the flag', async (t) => {
  const result = await runSafetyProbe(t, {
    frames: [
      sseFrame(SAFETY_METADATA_EVENT),
      sseFrame({
        type: 'response.created',
        safety_buffering: false,
        response: { id: 'resp_plain', model: 'gpt-5.4-2026-01-01', status: 'in_progress' },
      }),
      sseFrame({ type: 'response.output_text.delta', safety_buffering: false, delta: 'plain' }),
      sseFrame({
        type: 'response.completed',
        safety_buffering: false,
        response: { id: 'resp_plain', model: 'gpt-5.4-2026-01-01', status: 'completed' },
      }),
    ],
  })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'plain')
  assert.equal(result.debug.safety_buffering, false)
  assert.equal(result.debug.safety_buffering_enabled, 'true')
  assert.equal(result.debug.safety_buffering_faster_model, 'gpt-6-luna')
})

test('safety telemetry stays null when only config headers exist', async (t) => {
  const result = await runSafetyProbe(t, {
    frames: [
      sseFrame(SAFETY_METADATA_EVENT),
      sseFrame({
        type: 'response.created',
        response: { id: 'resp_none', model: 'gpt-5.4', status: 'in_progress' },
      }),
      sseFrame({ type: 'response.output_text.delta', delta: 'no flag' }),
      sseFrame({
        type: 'response.completed',
        response: { id: 'resp_none', model: 'gpt-5.4', status: 'completed' },
      }),
    ],
  })
  assert.equal(result.ok, true)
  assert.equal(result.debug.safety_buffering, null)
  assert.equal(result.debug.safety_buffering_enabled, 'true')
  assert.equal(result.debug.safety_buffering_faster_model, 'gpt-6-luna')
  assert.equal(result.debug.upstream_model, 'gpt-5.4')
})

test('safety telemetry lets an upstream true dominate conflicting false events', async (t) => {
  const result = await runSafetyProbe(t, {
    frames: [
      sseFrame({ type: 'response.created', safety_buffering: false, response: { id: 'resp_conflict' } }),
      sseFrame({ type: 'response.in_progress', safety_buffering: true }),
      sseFrame({ type: 'response.output_text.delta', safety_buffering: false, delta: 'mixed' }),
      sseFrame({
        type: 'response.completed',
        safety_buffering: false,
        response: { id: 'resp_conflict', status: 'completed' },
      }),
    ],
  })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'mixed')
  assert.equal(result.debug.safety_buffering, true)
})

test('safety telemetry reads a boolean from a non-streaming JSON response body', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-testchat-safety-json-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedCodexVm(root)
  seedRouting(root)
  const { baseUrl } = await startScriptedLoopbackServer(t, () => ({
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-codex-safety-buffering-enabled': 'true',
      'x-codex-safety-buffering-faster-model': 'gpt-6-luna',
    },
    body: {
      id: 'resp_json',
      object: 'response',
      model: 'gpt-5.4-2026-01-01',
      output_text: 'json hi',
      safety_buffering: false,
      status: 'completed',
    },
  }))
  const result = await runVmTestChat({
    projectRoot: root,
    vmId: 'vm-codex-01',
    model: 'gpt-5.4',
    prompt: 'hello',
    max_tokens: 16,
    baseUrl,
    apiKey: 'test-master-key',
  })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'json hi')
  assert.equal(result.debug.safety_buffering, false)
  assert.equal(result.debug.safety_buffering_enabled, 'true')
  assert.equal(result.debug.upstream_model, 'gpt-5.4-2026-01-01')
})

test('safety telemetry never copies unrelated response headers or string flags', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-testchat-safety-secret-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedCodexVm(root)
  seedRouting(root)
  const { baseUrl } = await startScriptedLoopbackServer(t, () => ({
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'x-codex-safety-buffering-enabled': 'true',
      'x-codex-safety-buffering-faster-model': 'm'.repeat(300),
      'x-upstream-secret': 'shh-do-not-copy',
      'set-cookie': 'session=shh-do-not-copy',
      'x-request-id': 'req-shh-do-not-copy',
    },
    frames: [
      sseFrame({ type: 'codex.response.metadata', headers: { 'x-codex-safety-buffering-enabled': 'true' } }),
      sseFrame({
        type: 'response.created',
        safety_buffering: 'true',
        response: { id: 'resp_secret', model: 'gpt-5.4', status: 'in_progress' },
      }),
      sseFrame({
        type: 'response.completed',
        safety_buffering: 'false',
        response: { id: 'resp_secret', model: 'gpt-5.4', status: 'completed' },
      }),
    ],
  }))
  const result = await runVmTestChat({
    projectRoot: root,
    vmId: 'vm-codex-01',
    model: 'gpt-5.4',
    prompt: 'hello',
    max_tokens: 16,
    baseUrl,
    apiKey: 'test-master-key',
  })
  assert.equal(result.ok, true)
  assert.equal(result.debug.safety_buffering, null)
  assert.equal(result.debug.safety_buffering_enabled, 'true')
  assert.equal(result.debug.safety_buffering_faster_model.length, 200)
  const debugJson = JSON.stringify(result.debug)
  assert.ok(!debugJson.includes('shh-do-not-copy'), 'debug must not leak unrelated headers')
  assert.equal(result.debug.headers, undefined)
  assert.equal(result.debug.upstream_headers, undefined)
  assert.ok(!Object.keys(result.debug).some((key) => /cookie|secret|authorization/i.test(key)))
})

// A real loopback stream that reports safety_buffering=true and then dies must
// keep the observation on the error path: the quality probe pauses on the
// signal even though the answer itself failed.
const SAFETY_TRUE_OPENING_FRAMES = [
  sseFrame(SAFETY_METADATA_EVENT),
  sseFrame({
    type: 'response.created',
    safety_buffering: true,
    response: { id: 'resp_cut', model: 'gpt-5.4-2026-01-01', status: 'in_progress' },
  }),
  sseFrame({ type: 'response.in_progress', safety_buffering: true }),
  sseFrame({ type: 'response.output_text.delta', safety_buffering: true, delta: 'half an answ' }),
]

test('a socket reset after an observed safety true keeps the pause signal and model', async (t) => {
  const result = await runSafetyProbe(t, { destroy: true, frames: SAFETY_TRUE_OPENING_FRAMES })
  assert.equal(result.ok, false)
  assert.equal(result.status, 0)
  assert.equal(result.error.type, 'worker_error')
  assert.equal(result.debug.safety_buffering, true)
  assert.equal(result.debug.safety_buffering_enabled, 'true')
  assert.equal(result.debug.safety_buffering_faster_model, 'gpt-6-luna')
  assert.equal(result.debug.upstream_model, 'gpt-5.4-2026-01-01')
  // The truncated stream is never reported as a usable answer.
  assert.equal(result.body, null)
  assert.equal(result.stop_reason, null)
  assert.equal(result.usage, null)
  assert.ok(!String(result.text || '').includes('half an answ'), 'partial text must not be surfaced')
})

test('a loopback timeout after an observed safety true keeps the pause signal and model', async (t) => {
  // 1ms is clamped to the 10s floor, so this really waits out the client timeout.
  const result = await runSafetyProbe(t, { hold: true, timeoutMs: 1, frames: SAFETY_TRUE_OPENING_FRAMES })
  assert.equal(result.ok, false)
  assert.equal(result.status, 0)
  assert.equal(result.error.type, 'cancelled')
  assert.equal(result.error.code, 'aborted')
  assert.equal(result.debug.safety_buffering, true)
  assert.equal(result.debug.safety_buffering_enabled, 'true')
  assert.equal(result.debug.safety_buffering_faster_model, 'gpt-6-luna')
  assert.equal(result.debug.upstream_model, 'gpt-5.4-2026-01-01')
  assert.equal(result.body, null)
  assert.ok(!String(result.text || '').includes('half an answ'), 'partial text must not be surfaced')
})

test('an interrupted stream keeps an explicit false and never infers a missing flag', async (t) => {
  const withFalse = await runSafetyProbe(t, {
    destroy: true,
    frames: [
      sseFrame(SAFETY_METADATA_EVENT),
      sseFrame({
        type: 'response.created',
        safety_buffering: false,
        response: { id: 'resp_false_cut', model: 'gpt-5.4-2026-01-01', status: 'in_progress' },
      }),
    ],
  })
  assert.equal(withFalse.ok, false)
  assert.equal(withFalse.debug.safety_buffering, false)
  assert.equal(withFalse.debug.upstream_model, 'gpt-5.4-2026-01-01')

  const withoutFlag = await runSafetyProbe(t, { destroy: true, frames: [sseFrame(SAFETY_METADATA_EVENT)] })
  assert.equal(withoutFlag.ok, false)
  assert.equal(withoutFlag.debug.safety_buffering, null)
  assert.equal(withoutFlag.debug.safety_buffering_enabled, 'true')
  assert.equal(withoutFlag.debug.upstream_model, null)
})

test('background discovery does not wake resting, busy or quota-cooled accounts', async (t) => {
  const root = catalogFixture(t, 3)
  const patch = (id, fn) => {
    const file = path.join(root, 'vms', `${id}.json`)
    const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    fn(vm)
    fs.writeFileSync(file, JSON.stringify(vm))
  }
  patch('vm-catalog-00', (vm) => {
    vm.policy = {
      active_hours: {
        start: '00:00',
        end: '23:59',
        timezone: 'UTC',
        days: [(new Date().getUTCDay() + 1) % 7],
      },
    }
  })
  const seat = tryAcquireOpenAISlot('vm-catalog-01')
  t.after(() => seat.release())
  patch('vm-catalog-02', (vm) => {
    vm.codex.extra = {
      codex_limited_until: new Date(Date.now() + 3600000).toISOString(),
    }
  })
  let calls = 0
  const result = await syncCodexCatalog({
    projectRoot: root,
    rotate: false,
    catalogClientVersion: '0.164.0',
    fetchImpl: async () => {
      calls++
      return catalogReply('unexpected')
    },
  })
  assert.equal(result.error, 'no_codex_slot')
  assert.equal(calls, 0)
})

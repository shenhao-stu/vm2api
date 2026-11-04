import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { ApiEndpointStore } from '../../src/lib/admin/api-endpoints.mjs'
import { ApiScheduler } from '../../src/lib/pool/api-scheduler.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { keyAllowsVm } from '../../src/lib/admin/key-scope.mjs'

const gpt = 'gpt-6.1-sol'
const claude = 'claude-sonnet-4-6'
function fakeResponse() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    headersSent: false,
    chunks: [],
    writeHead(status) {
      this.statusCode = status
      this.headersSent = true
    },
    setHeader() {},
    write(chunk) {
      this.headersSent = true
      this.chunks.push(String(chunk))
      return true
    },
    end() {
      this.writableEnded = true
      this.writableFinished = true
      this.emit('finish')
    },
  })
}
async function upstream(t, handle) {
  const server = http.createServer(handle)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}
function harness(t, origin, { requiredGuard = true, gatewayOnly = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-protocol-'))
  const db = openDatabase({ dbPath: path.join(root, 'kin.db') })
  t.after(() => {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  })
  new SettingsRepo(db).set('proxy_exit_guard', { required: requiredGuard, proxies: {} })
  const keys = new ApiKeyStore({ db })
  const endpoints = new ApiEndpointStore({ db })
  const ep = endpoints.create({
    kind: 'local_gateway',
    protocol: 'openai',
    base_url: origin,
    models: [{ name: gpt, alias: gpt }],
    api_key_entries: [{ api_key: 'upstream-test-secret' }],
  })
  const key = keys.create({
    category: 'hybrid',
    openai_endpoint_id: ep.id,
    group_type: gatewayOnly ? 'openai' : 'anthropic',
    allowed_vms: gatewayOnly ? [] : ['vm-one'],
    vm_pool_id: null,
    max_concurrency: 1,
  })
  const scheduler = new ApiScheduler()
  scheduler.reload(endpoints.listRaw())
  const routingConfig = { compatibility: { claude_code_only: false }, failover: { stream_keepalive_ms: 0 } }
  const routingConfigPath = path.join(root, 'routing.json')
  fs.writeFileSync(routingConfigPath, JSON.stringify(routingConfig))
  const nativeCalls = []
  const logs = []
  const json = (res, status, body) => {
    res.statusCode = status
    res.body = body
    res.end()
    return body
  }
  const handlers = createHandleProtocol({
    json,
    writeSSEHeaders: (res) => res.writeHead(200),
    readBody: async (req) => req.body,
    requireAuth(req, res) {
      const auth = keys.authenticate(String(req.headers.authorization || '').replace(/^Bearer /, ''))
      if (!auth.ok) {
        json(res, 401, { error: { code: 'invalid_api_key' } })
        return false
      }
      req.apiKeyKind = 'managed'
      req.apiKeyRecord = auth.record
      const gate = keys.canAccept(auth.record)
      if (!gate.ok) {
        json(res, gate.status, { error: { code: gate.code } })
        return false
      }
      return true
    },
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 1500, stream_idle_timeout_ms: 1500 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'hybrid-test', t0: Date.now() }), finish: (_ctx, log) => logs.push(log) },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: {},
    apiKeyStore: keys,
    apiEndpointStore: endpoints,
    apiScheduler: scheduler,
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath,
    routingConfig,
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: {
      async run(options) {
        nativeCalls.push(options)
        return {
          ok: true,
          status: 200,
          finalState: 'verified',
          terminalState: 'verified',
          attemptCount: 1,
          accountId: 'native-account',
          vmId: 'vm-one',
          usage: { input_tokens: 4, output_tokens: 1 },
          body: {
            type: 'message',
            role: 'assistant',
            model: claude,
            content: [{ type: 'text', text: 'native success' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 4, output_tokens: 1 },
          },
        }
      },
    },
  })
  function call(body, { protocol = 'openai.responses', token = key.key, route, headers = {} } = {}) {
    const res = fakeResponse()
    const req = Object.assign(new EventEmitter(), {
      body,
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'python-requests/2.32.0', ...headers },
      method: 'POST',
      url: route || '/v1/responses',
    })
    const promise =
      route === 'search'
        ? handlers.handleSearch(req, res, '/v1/alpha/search')
        : route === 'images'
          ? handlers.handleImages(req, res, '/v1/images/generations', 'generations')
          : handlers.handleProtocol(req, res, protocol, '/v1/responses')
    return { req, res, done: promise.then(() => res) }
  }
  return { call, key, keys, ep, endpoints, scheduler, nativeCalls, logs }
}

test('full handler authenticates and routes only configured GPT to a local gateway with required guard intact', async (t) => {
  let calls = 0
  const origin = await upstream(t, (req, res) => {
    calls++
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        status: 'completed',
        model: gpt,
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
        usage: { input_tokens: 9, output_tokens: 2 },
      }),
    )
  })
  const h = harness(t, origin)
  const unauthorized = await h.call({ model: gpt, input: 'hi' }, { token: 'wrong' }).done
  assert.equal(unauthorized.statusCode, 401)
  const good = await h.call({ model: gpt, input: 'hi' }).done
  assert.equal(good.statusCode, 200, JSON.stringify(good.body))
  assert.equal(calls, 1)
  assert.equal(h.nativeCalls.length, 0)
  const unlisted = await h.call({ model: 'gpt-5.5', input: 'hi' }).done
  assert.equal(unlisted.statusCode, 404)
  assert.equal(calls, 1)
  assert.equal(h.keys.getById(h.key.id).requests, 1)
  assert.equal(h.keys.getById(h.key.id).tokens_in, 9)
  assert.equal(
    h.logs.some((row) => row.via === 'local-gateway' && row.final_state === 'verified'),
    true,
  )
})

test('one key shares concurrency across an in-flight GPT turn and ordinary Python Claude requests', async (t) => {
  let accept
  const entered = new Promise((resolve) => {
    accept = resolve
  })
  let finish
  const origin = await upstream(t, (req, res) => {
    req.resume()
    finish = () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      )
    }
    accept()
  })
  const h = harness(t, origin)
  const first = h.call({ model: gpt, input: 'hi' })
  await entered
  const blocked = await h.call(
    { model: claude, messages: [{ role: 'user', content: 'hello' }], max_tokens: 8 },
    { protocol: 'anthropic.messages' },
  ).done
  assert.equal(blocked.statusCode, 429, JSON.stringify(blocked.body))
  assert.equal(blocked.body.error.code, 'api_key_concurrency_limit')
  assert.equal(h.nativeCalls.length, 0)
  finish()
  await first.done
  const native = await h.call(
    { model: claude, messages: [{ role: 'user', content: 'hello again' }], max_tokens: 8 },
    { protocol: 'anthropic.messages' },
  ).done
  assert.equal(native.statusCode, 200, JSON.stringify(native.body))
  assert.equal(h.nativeCalls.length, 1)
  assert.deepEqual(h.nativeCalls[0].keyScope.allowed_vms, ['vm-one'])
  assert.equal(keyAllowsVm(h.nativeCalls[0].keyScope, { id: 'foreign', platform: 'anthropic' }), false)
  assert.equal(h.nativeCalls[0].canonicalBody.model, claude)
  assert.equal(h.keys.inflight.get(h.key.id) || 0, 0)
})

test('client disconnect releases the same key and rejected hybrid protocols never reach native GPT', async (t) => {
  let accept
  const entered = new Promise((resolve) => {
    accept = resolve
  })
  let calls = 0
  const origin = await upstream(t, (req) => {
    calls++
    req.resume()
    accept()
  })
  const h = harness(t, origin)
  const first = h.call({ model: gpt, input: 'hi', stream: true })
  await entered
  first.req.aborted = true
  first.req.emit('aborted')
  await first.done
  assert.equal(h.keys.inflight.get(h.key.id) || 0, 0)
  assert.equal(h.keys.getById(h.key.id).requests, 0)
  for (const route of ['search']) {
    const denied = await h.call({ model: gpt }, { route }).done
    assert.equal(denied.statusCode, 400)
    assert.equal(denied.body.error.code, 'hybrid_protocol_unsupported')
  }
  assert.equal(calls, 1)
  assert.equal(h.nativeCalls.length, 0)
})

test('gateway 429 preserves Retry-After and cools only its configured credential without another dispatch', async (t) => {
  let calls = 0
  const origin = await upstream(t, (req, res) => {
    calls++
    req.resume()
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '10' })
    res.end(JSON.stringify({ error: { code: 'upstream_rate_limit', message: 'capacity' } }))
  })
  const h = harness(t, origin)
  const first = await h.call({ model: gpt, input: 'hi' }).done
  assert.equal(first.statusCode, 429)
  assert.equal(first.body.error.code, 'upstream_rate_limit')
  assert.ok(Date.parse(h.endpoints.getRaw(h.ep.id).api_key_entries[0].cooldown_until) > Date.now())
  const second = await h.call({ model: gpt, input: 'hi' }).done
  assert.equal(second.statusCode, 503)
  assert.equal(calls, 1)
  assert.equal(h.nativeCalls.length, 0)
})

test('separate GPT and Claude keys reject cross-pool requests and each retain concurrency one', async (t) => {
  let accepted
  const entered = new Promise((resolve) => {
    accepted = resolve
  })
  let finish
  let calls = 0
  const origin = await upstream(t, (req, res) => {
    calls++
    req.resume()
    finish = () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          status: 'completed',
          model: gpt,
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'GPT answer' }] }],
          usage: { input_tokens: 2, output_tokens: 3 },
        }),
      )
    }
    accepted()
  })
  const h = harness(t, origin, { gatewayOnly: true })
  const claudeKey = h.keys.create({
    category: 'oauth',
    group_type: 'anthropic',
    allowed_vms: ['vm-one'],
    max_concurrency: 1,
  })
  const deniedClaude = await h.call(
    { model: claude, messages: [{ role: 'user', content: 'hello' }] },
    { protocol: 'anthropic.messages' },
  ).done
  assert.equal(deniedClaude.statusCode, 403)
  assert.equal(deniedClaude.body.error.code, 'key_group_mismatch')
  const deniedGpt = await h.call({ model: gpt, input: 'hello' }, { token: claudeKey.key }).done
  assert.equal(deniedGpt.statusCode, 409)
  assert.equal(deniedGpt.body.error.code, 'exit_guard_blocked')
  assert.equal(calls, 0)
  assert.equal(h.nativeCalls.length, 0)
  const first = h.call({ model: gpt, input: 'hello' })
  await entered
  assert.equal((await h.call({ model: gpt, input: 'hello' }).done).statusCode, 429)
  const native = await h.call(
    { model: claude, messages: [{ role: 'user', content: 'hello' }] },
    { protocol: 'anthropic.messages', token: claudeKey.key },
  ).done
  assert.equal(native.statusCode, 200)
  assert.equal(h.nativeCalls.length, 1)
  assert.equal(h.keys.acquire(claudeKey).ok, true)
  assert.equal(h.keys.acquire(claudeKey).ok, false)
  h.keys.release(claudeKey)
  finish()
  assert.equal((await first.done).statusCode, 200)
  assert.equal(calls, 1)
  assert.equal(h.keys.getById(h.key.id).requests, 1)
  assert.equal(h.keys.getById(claudeKey.id).requests, 1)
})

test('GPT-only keys reject Claude models without changing native Fable scheduling', async (t) => {
  let calls = 0
  const origin = await upstream(t, (_req, res) => {
    calls++
    res.end('{}')
  })
  const h = harness(t, origin, { gatewayOnly: true })
  const denied = await h.call(
    { model: 'claude-fable-5-1', messages: [{ role: 'user', content: 'hi' }] },
    { protocol: 'anthropic.messages' },
  ).done
  assert.equal(denied.statusCode, 403)
  assert.equal(denied.body.error.code, 'key_group_mismatch')
  assert.equal(calls, 0)
  assert.equal(h.nativeCalls.length, 0)
})

for (const [label, output, usage, expectedRequests] of [
  [
    'completed but unusable visible output',
    [{ type: 'reasoning', summary: [] }],
    { input_tokens: 100, output_tokens: 5 },
    1,
  ],
  [
    'completed tool conversion failure',
    [{ type: 'function_call', call_id: 'call_one', arguments: '{}' }],
    { input_tokens: 100, output_tokens: 5 },
    1,
  ],
  [
    'completed without authoritative usage',
    [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
    undefined,
    0,
  ],
]) {
  test(`gateway accounting is independent of downstream completion: ${label}`, async (t) => {
    let calls = 0
    const origin = await upstream(t, (req, res) => {
      calls++
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'completed', model: gpt, output, usage }))
    })
    const h = harness(t, origin, { gatewayOnly: true })
    const records = []
    const recordUsage = h.keys.recordUsage.bind(h.keys)
    h.keys.recordUsage = (...args) => {
      records.push(args)
      return recordUsage(...args)
    }
    const reply = await h.call(
      { model: gpt, messages: [{ role: 'user', content: 'hello' }] },
      { protocol: 'openai.chat' },
    ).done
    assert.equal(reply.statusCode, 502)
    assert.equal(calls, 1)
    assert.equal(records.length, expectedRequests)
    assert.equal(h.keys.getById(h.key.id).requests, expectedRequests)
    assert.equal(h.keys.inflight.get(h.key.id) || 0, 0)
    if (usage) {
      assert.equal(records[0][1].input_tokens, 100)
      assert.equal(records[0][1].output_tokens, 5)
      assert.ok(records[0][2].officialCost > 0)
      assert.equal(h.keys.getById(h.key.id).quota_used, records[0][2].officialCost)
      assert.equal(h.logs[0].usage.input_tokens, 100)
    }
  })
}

test('unexpected upstream billing tier preserves usage for review without inventing a free receipt', async (t) => {
  let calls = 0
  const origin = await upstream(t, (req, res) => {
    calls++
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        status: 'completed',
        model: gpt,
        service_tier: 'unknown-tier',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
        usage: { input_tokens: 100, output_tokens: 5 },
      }),
    )
  })
  const h = harness(t, origin, { gatewayOnly: true })
  const reply = await h.call({ model: gpt, input: 'hello' }).done
  assert.equal(reply.statusCode, 502)
  assert.equal(reply.body.error.code, 'gateway_usage_unpriced')
  assert.equal(calls, 1)
  assert.equal(h.keys.getById(h.key.id).requests, 0)
  assert.equal(h.logs[0].final_state, 'billing_pending')
  assert.equal(h.logs[0].total_cost, null)
  assert.equal(h.logs[0].usage.input_tokens, 100)
})

test('different managed keys cannot collide through caller-supplied session headers', async (t) => {
  const received = []
  const origin = await upstream(t, (req, res) => {
    received.push(req.headers)
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        status: 'completed',
        model: gpt,
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
        usage: { input_tokens: 3, output_tokens: 1 },
      }),
    )
  })
  const h = harness(t, origin, { gatewayOnly: true })
  const second = h.keys.create({
    category: 'hybrid',
    group_type: 'openai',
    allowed_vms: [],
    openai_endpoint_id: h.ep.id,
  })
  const headers = Object.fromEntries(
    ['session-id', 'thread-id', 'x-codex-parent-thread-id', 'x-codex-turn-metadata', 'x-codex-turn-state'].map(
      (key) => [key, 'same-session'],
    ),
  )
  for (const token of [h.key.key, second.key]) {
    const reply = await h.call({ model: gpt, input: 'hello', prompt_cache_key: 'performance-hint' }, { token, headers })
      .done
    assert.equal(reply.statusCode, 200)
  }
  assert.equal(received.length, 2)
  for (const entry of received) for (const key of Object.keys(headers)) assert.equal(entry[key], undefined)
  assert.equal(h.keys.getById(h.key.id).requests, 1)
  assert.equal(h.keys.getById(second.id).requests, 1)
})

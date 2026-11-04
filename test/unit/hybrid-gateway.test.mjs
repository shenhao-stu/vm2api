import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { ApiEndpointStore, fetchUpstreamModels } from '../../src/lib/admin/api-endpoints.mjs'
import { ApiScheduler } from '../../src/lib/pool/api-scheduler.mjs'
import { localGatewayOrigin, hybridModelCatalog } from '../../src/lib/pool/local-gateway-policy.mjs'
import { runHostedGateway } from '../../src/lib/protocol/hosted-gateway.mjs'

const model = 'gpt-6.1-sol'
function endpoint(base_url = 'http://127.0.0.1:8787', extra = {}) {
  return {
    id: 'ep_123456789abc',
    name: 'GPT',
    kind: 'local_gateway',
    protocol: 'openai',
    base_url,
    headers: {},
    models: [{ name: model, alias: model }],
    api_key_entries: [{ id: 'ek_test', api_key: 'upstream-key' }],
    ...extra,
  }
}
function response() {
  const res = new EventEmitter()
  return Object.assign(res, {
    headersSent: false,
    chunks: [],
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    write(chunk) {
      this.chunks.push(Buffer.from(chunk))
      return true
    },
    end() {
      this.ended = true
    },
    setHeader() {},
  })
}
async function server(t, handle) {
  const srv = http.createServer(handle)
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    srv.closeAllConnections()
    await new Promise((resolve) => srv.close(resolve))
  })
  return `http://127.0.0.1:${srv.address().port}`
}
function schedule(ep) {
  const scheduler = new ApiScheduler()
  scheduler.reload([ep])
  return scheduler
}
async function run(
  ep,
  {
    protocol = 'openai.responses',
    body = { model, input: 'hello', stream: false },
    signal,
    res = response(),
    headers = {},
    timeoutMs = 1000,
  } = {},
) {
  const result = await runHostedGateway({
    req: { headers },
    res,
    endpoint: ep,
    scheduler: schedule(ep),
    body,
    protocol,
    signal,
    timeoutMs,
  })
  return { result, res }
}

test('local gateway origins are numeric loopback only, without authority/path escapes', () => {
  for (const value of ['http://127.0.0.1:8787', 'https://[::1]:443']) assert.ok(localGatewayOrigin(value))
  for (const value of [
    'https://storyboardbook.cn',
    'http://localhost',
    'http://127.0.0.1.evil.test',
    'http://127.0.0.1@evil.test',
    'http://user:pass@127.0.0.1',
    'http://127.0.0.1/v1',
    'http://127.0.0.1/?target=evil',
    'http://127.0.0.1/#x',
    'file:///tmp/a',
  ]) {
    assert.throws(() => localGatewayOrigin(value), { code: 'invalid_local_gateway' }, value)
  }
})

test('hybrid key persistence preserves the Claude allowlist and rejects broadening it to all', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-key-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const keys = new ApiKeyStore({ dataDir: dir })
  const endpoints = new ApiEndpointStore({ db: keys.db })
  const ep = endpoints.create(endpoint())
  const key = keys.create({
    category: 'hybrid',
    openai_endpoint_id: ep.id,
    group_type: 'anthropic',
    allowed_vms: ['vm-one'],
    max_concurrency: 1,
  })
  assert.equal(keys.authenticate(key.key).record.openai_endpoint_id, ep.id)
  assert.deepEqual(keys.list()[0].allowed_vms, ['vm-one'])
  assert.equal(keys.list()[0].category, 'hybrid')
  assert.throws(() => keys.update(key.id, { group_type: 'all' }), { code: 'hybrid_claude_scope_required' })
  assert.deepEqual(keys.list()[0].allowed_vms, ['vm-one'])
  assert.throws(() => keys.update(key.id, { openai_endpoint_id: 'ep_000000000000' }), {
    code: 'local_gateway_required',
  })
  assert.equal(keys.acquire(key).ok, true)
  assert.equal(keys.acquire(keys.authenticate(key.key).record).code, 'api_key_concurrency_limit')
  keys.release(key)
  assert.equal(keys.acquire(key).ok, true)
  keys.release(key)
  assert.throws(() => endpoints.update(ep.id, { base_url: 'https://outside.invalid' }), {
    code: 'invalid_local_gateway',
  })
  assert.throws(() => endpoints.updateKey(ep.api_key_entries[0].id, { proxy_url: 'socks5://127.0.0.1:1234' }), {
    code: 'invalid_local_gateway',
  })
  assert.throws(() => endpoints.replaceModels(ep.id, [{ name: 'claude-opus-4-6', alias: 'claude-opus-4-6' }]), {
    code: 'invalid_gateway_model',
  })
})

test('local gateway catalog is never exposed to ordinary API keys; selection binds endpoint and exact model', () => {
  const ep = endpoint()
  const other = endpoint('http://127.0.0.1:8788', { id: 'ep_000000000000' })
  const picker = schedule(ep)
  picker.reload([ep, other])
  assert.deepEqual(picker.catalog().data, [])
  assert.equal(picker.pick(model).ok, false)
  assert.equal(picker.pick(model, Date.now(), { localGatewayId: ep.id }).endpoint.id, ep.id)
  assert.equal(picker.pick(model.toUpperCase(), Date.now(), { localGatewayId: ep.id }).ok, false)
  ep.disabled = true
  assert.equal(picker.pick(model, Date.now(), { localGatewayId: ep.id }).ok, false)
})

test('hybrid catalog reflects authorized native slot allowlists and Pro tier, plus only explicit GPT models', () => {
  const native = {
    data: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-fable-5-1', 'auto', 'gpt-5.5'].map((id) => ({ id })),
  }
  const result = hybridModelCatalog(native, endpoint(), {
    nativeVms: [{ id: 'vm-one', platform: 'anthropic', account_tier: 'pro', allowed_models: ['claude-sonnet-4-6'] }],
  })
  assert.deepEqual(
    result.data.map((m) => m.id),
    ['claude-sonnet-4-6', model],
  )
  assert.deepEqual(
    hybridModelCatalog(native, endpoint()).data.map((m) => m.id),
    [model],
  )
})

test('local gateway model fetching cannot silently expand the approved catalog', async () => {
  let calls = 0
  await assert.rejects(
    fetchUpstreamModels({
      kind: 'local_gateway',
      protocol: 'openai',
      base_url: 'http://127.0.0.1:8787',
      api_key: 'abcd',
      forward: () => {
        calls++
      },
    }),
    { code: 'gateway_models_explicit' },
  )
  assert.equal(calls, 0)
})

test('real loopback hop preserves Responses fields and replaces caller authentication once', async (t) => {
  let requests = 0
  const origin = await server(t, async (req, res) => {
    requests++
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    assert.equal(req.url, '/v1/responses')
    assert.equal(req.headers.authorization, 'Bearer upstream-key')
    assert.equal(req.headers.cookie, undefined)
    assert.deepEqual(body.tools, [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }])
    assert.equal(body.previous_response_id, 'resp_previous')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'resp_one',
        status: 'completed',
        model,
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
        usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } },
      }),
    )
  })
  const { result } = await run(endpoint(origin), {
    headers: { authorization: 'Bearer client-secret', cookie: 'private=client' },
    body: {
      model,
      input: 'hello',
      stream: false,
      previous_response_id: 'resp_previous',
      tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }],
    },
  })
  assert.equal(result.ok, true)
  assert.equal(requests, 1)
  assert.equal(result.usage.input_tokens, 6)
  assert.equal(result.usage.cache_read_input_tokens, 4)
  assert.equal(result.body.id, 'resp_one')
})

test('SSE bytes including split UTF-8 survive while final usage and terminal evidence are recorded', async (t) => {
  const bytes = Buffer.from(
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '你好' })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 7, output_tokens: 3 } } })}\n\n`,
  )
  const origin = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const cut = bytes.indexOf(Buffer.from('你好')) + 1
    res.write(bytes.subarray(0, cut))
    setTimeout(() => res.end(bytes.subarray(cut)), 5)
  })
  const { result, res } = await run(endpoint(origin), { body: { model, input: 'hello', stream: true } })
  assert.equal(result.ok, true)
  assert.deepEqual(Buffer.concat(res.chunks), bytes)
  assert.equal(result.usage.output_tokens, 3)
  assert.equal(result.attemptCount, 1)
  assert.ok(res.chunks.length >= 2)
})

test('redirects are refused without credential delivery to the destination', async (t) => {
  let targetCalls = 0
  const target = await server(t, (_req, res) => {
    targetCalls++
    res.end('{}')
  })
  const origin = await server(t, (_req, res) => {
    res.writeHead(307, { location: target })
    res.end()
  })
  const { result } = await run(endpoint(origin))
  assert.equal(result.errorCode, 'gateway_redirect_refused')
  assert.equal(targetCalls, 0)
})

test('accepted then disconnected request is never replayed', async (t) => {
  let requests = 0
  const origin = await server(t, async (req) => {
    requests++
    for await (const _ of req) {
    }
    req.socket.destroy()
  })
  const { result } = await run(endpoint(origin))
  assert.equal(result.ok, false)
  assert.equal(result.attemptCount, 1)
  assert.equal(requests, 1)
})

test('client abort cancels a hanging upstream and does not claim verified usage', async (t) => {
  let accepted
  const entered = new Promise((resolve) => {
    accepted = resolve
  })
  const origin = await server(t, (req) => {
    accepted()
    req.resume()
  })
  const control = new AbortController()
  const running = run(endpoint(origin), { signal: control.signal })
  await entered
  control.abort(new Error('disconnected'))
  const { result } = await running
  assert.equal(result.status, 499)
  assert.equal(result.terminalState, 'cancelled')
})

test('truncated and thinking-only SSE retain evidence but fail completion without replay', async (t) => {
  let calls = 0
  const origin = await server(t, (_req, res) => {
    calls++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"type":"response.reasoning_summary_text.delta","delta":"hidden"}\n\n')
  })
  const { result } = await run(endpoint(origin), { body: { model, input: 'hello', stream: true } })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'gateway_incomplete_response')
  assert.equal(calls, 1)
})

test('empty and reasoning-only completed Responses are incomplete; tool-only remains valid', async (t) => {
  let output = []
  let requests = 0
  const origin = await server(t, (_req, res) => {
    requests++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'completed', output, usage: { input_tokens: 2, output_tokens: 5 } }))
  })
  for (const value of [[], [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'hidden thought' }] }]]) {
    output = value
    const { result } = await run(endpoint(origin))
    assert.equal(result.ok, false)
    assert.equal(result.usage.output_tokens, 5)
    assert.equal(result.errorCode, 'gateway_incomplete_response')
  }
  output = [{ type: 'function_call', name: 'lookup', arguments: '{}', call_id: 'call_1' }]
  assert.equal((await run(endpoint(origin))).result.ok, true)
  assert.equal(requests, 3)
})

test('Chat SSE has a finish and DONE only after a visible completed Responses result', async (t) => {
  let text = 'hello'
  let completed = false
  const origin = await server(t, (req, res) => {
    assert.equal(req.url, '/v1/responses')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n${completed ? `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 2 } } })}\n\n` : ''}`,
    )
  })
  const opts = {
    protocol: 'openai.chat',
    body: { model, messages: [{ role: 'user', content: 'hello' }], stream: true },
  }
  const incomplete = await run(endpoint(origin), opts)
  assert.equal(incomplete.result.ok, false)
  assert.doesNotMatch(Buffer.concat(incomplete.res.chunks).toString(), /\[DONE\]/)
  completed = true
  const complete = await run(endpoint(origin), opts)
  assert.equal(complete.result.ok, true)
  assert.match(Buffer.concat(complete.res.chunks).toString(), /"finish_reason":"stop"/)
  assert.match(Buffer.concat(complete.res.chunks).toString(), /\[DONE\]/)
  text = ''
  assert.equal((await run(endpoint(origin), opts)).result.ok, false)
})

test('Chat, Completions and Messages JSON requests use Responses and return the caller schema', async (t) => {
  let calls = 0
  const origin = await server(t, async (req, res) => {
    calls++
    assert.equal(req.url, '/v1/responses')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const incoming = JSON.parse(Buffer.concat(chunks))
    assert.equal(incoming.stream, false)
    assert.equal(incoming.max_output_tokens, 24)
    assert.ok(incoming.input.some((item) => item.content?.some((block) => block.text === 'hello')))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'resp_json',
        status: 'completed',
        model,
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }],
        usage: { input_tokens: 14, output_tokens: 9, input_tokens_details: { cached_tokens: 4 } },
      }),
    )
  })
  for (const protocol of ['openai.chat', 'openai.completions', 'anthropic.messages']) {
    const body = {
      model,
      stream: false,
      max_tokens: 24,
      ...(protocol === 'openai.completions' ? { prompt: 'hello' } : { messages: [{ role: 'user', content: 'hello' }] }),
    }
    const { result } = await run(endpoint(origin), { protocol, body })
    assert.equal(result.ok, true, JSON.stringify(result))
    if (protocol === 'anthropic.messages') {
      assert.equal(result.body.type, 'message')
      assert.equal(result.body.content[0].text, 'answer')
      assert.equal(result.body.usage.input_tokens, 10)
    } else {
      assert.equal(result.body.choices[0].message?.content || result.body.choices[0].text, 'answer')
      assert.equal(result.body.choices[0].finish_reason, 'stop')
      assert.equal(result.body.usage.prompt_tokens, 14)
    }
    assert.equal(result.usage.input_tokens, 10)
    assert.equal(result.usage.cache_read_input_tokens, 4)
    assert.equal(result.usage.output_tokens, 9)
  }
  assert.equal(calls, 3)
})

test('completed-only and partial-delta Responses streams preserve exact caller text without duplication', async (t) => {
  let prefix = ''
  const origin = await server(t, (req, res) => {
    assert.equal(req.url, '/v1/responses')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `${prefix ? `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: prefix })}\n\n` : ''}data: ${JSON.stringify(
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            model,
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello world' }] }],
            usage: { input_tokens: 2, output_tokens: 3 },
          },
        },
      )}\n\n`,
    )
  })
  for (const protocol of ['openai.chat', 'openai.completions', 'anthropic.messages']) {
    for (prefix of ['', 'hello ']) {
      const { result, res } = await run(endpoint(origin), {
        protocol,
        body: { model, stream: true, messages: [{ role: 'user', content: 'hi' }], prompt: 'hi' },
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const events = Buffer.concat(res.chunks)
        .toString()
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)))
      const text = events
        .map((event) => event.delta?.text || event.choices?.[0]?.delta?.content || event.choices?.[0]?.text || '')
        .join('')
      assert.equal(text, 'hello world')
      assert.equal(result.usage.output_tokens, 3)
    }
  }
})

test('a JSON caller never receives an unexpected SSE success response', async (t) => {
  let calls = 0
  const origin = await server(t, (_req, res) => {
    calls++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}]}}\n\n',
    )
  })
  const { result, res } = await run(endpoint(origin))
  assert.equal(result.errorCode, 'gateway_protocol_error')
  assert.equal(result.committed, false)
  assert.equal(res.headersSent, false)
  assert.equal(calls, 1)
})

test('exact aliases listed by a local gateway are also selectable, including distinct casing', () => {
  const ep = endpoint()
  ep.models.push({ name: model, alias: model.toUpperCase() })
  const listed = hybridModelCatalog({ data: [] }, ep).data.map((m) => m.id)
  assert.deepEqual(listed, [model, model.toUpperCase()])
  for (const id of listed) assert.equal(schedule(ep).pick(id, Date.now(), { localGatewayId: ep.id }).ok, true)
})

test('zero budget does not dispatch; an upstream that never responds consumes only its bounded deadline', async (t) => {
  let calls = 0
  const origin = await server(t, (req) => {
    calls++
    req.resume()
  })
  const zero = await run(endpoint(origin), { timeoutMs: 0 })
  assert.equal(zero.result.status, 504)
  assert.equal(zero.result.attemptCount, 0)
  assert.equal(calls, 0)
  const began = Date.now()
  const expired = await run(endpoint(origin), { timeoutMs: 25 })
  assert.equal(expired.result.status, 504)
  assert.equal(calls, 1)
  assert.ok(Date.now() - began < 500)
})

test('GPT-only gateway key persists an empty native scope but cannot attach slots or a pool', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-only-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const keys = new ApiKeyStore({ dataDir: dir })
  const endpoints = new ApiEndpointStore({ db: keys.db })
  const ep = endpoints.create(endpoint())
  const key = keys.create({
    category: 'hybrid',
    openai_endpoint_id: ep.id,
    group_type: 'openai',
    allowed_vms: [],
    vm_pool_id: null,
    max_concurrency: 1,
  })
  const saved = keys.authenticate(key.key).record
  assert.equal(saved.group_type, 'openai')
  assert.deepEqual(keys.list()[0].allowed_vms, [])
  assert.equal(keys.update(key.id, { max_concurrency: 1 }).group_type, 'openai')
  assert.throws(() => keys.update(key.id, { allowed_vms: ['vm-one'] }), { code: 'gateway_only_scope_required' })
  assert.throws(() => keys.update(key.id, { vm_pool_id: 'pool_abcd1234' }), { code: 'gateway_only_scope_required' })
  assert.throws(() => keys.create({ category: 'oauth', group_type: 'openai', allowed_vms: [] }), {
    code: 'key_vms_required',
  })
  const catalog = hybridModelCatalog({ data: [{ id: 'claude-sonnet-4-6' }, { id: 'claude-fable-5' }] }, ep, {
    record: saved,
    nativeVms: [{ id: 'vm-one', platform: 'anthropic', account_tier: 'max' }],
  })
  assert.deepEqual(
    catalog.data.map((entry) => entry.id),
    [model],
  )
  assert.equal(catalog.source, 'local_gateway')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { anthropicClientHeaders } from '../../src/lib/pool/api-protocol.mjs'
import { telemetryIngressResponse, isTelemetryPath } from '../../src/lib/identity/telemetry-rewrite.mjs'

const events = [
  {
    type: 'message_start',
    message: {
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 2,
        output_tokens: 0,
        cache_creation_input_tokens: 8,
        cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 3 },
      },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]
  .map((data) => `data: ${JSON.stringify(data)}\n\n`)
  .join('')

async function fixture(t, enabled) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-raw-api-'))
  const routing = {
    compatibility: { persona_preset: 'official_full', min_max_tokens: { enabled: true, value: 128 } },
    failover: { eager_tool_streaming: true },
  }
  fs.mkdirSync(path.join(root, 'run'))
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  const received = []
  const charges = []
  const kernel = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    received.push(JSON.parse(Buffer.concat(chunks)))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(events)
  })
  await new Promise((resolve) => kernel.listen(path.join(root, 'run/api-kernel.sock'), resolve))
  t.after(async () => {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  async function invoke(body, { protocol = 'anthropic.messages', headers = {} } = {}) {
    const response = { headersSent: false, on() {}, once() {}, off() {}, write() {}, end() {} }
    const handler = createHandleProtocol({
      json: (_res, status, value) => Object.assign(response, { status, body: value }),
      writeSSEHeaders() {},
      readBody: async () => body,
      requireAuth: () => true,
      cfg: {
        api_passthrough: enabled,
        rewrite: { enabled: false },
        intercept: { rules: [] },
        distill: { enabled: false },
        limits: { max_body_bytes: 1048576, upstream_timeout_ms: 2000 },
        paths: { data: root, project: root },
      },
      requestLog: { start: () => ({ request_id: 'fixture' }), finish() {} },
      stickyRouter: {},
      accountQuota: {},
      apiKeyStore: { acquire: () => ({ ok: true }), release() {}, recordUsage: (_key, usage) => charges.push(usage) },
      apiEndpointStore: {},
      apiScheduler: {
        pick: () => ({
          ok: true,
          endpoint: {
            id: 'ep',
            kind: 'custom',
            protocol: 'anthropic',
            base_url: 'http://fixture.invalid',
            auth_scheme: 'authorization_bearer',
          },
          key: { id: 'key', api_key: 'upstream-fixture-key' },
          upstream_model: 'claude-sonnet-4-6',
        }),
      },
      stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
      routingConfigPath: routingFile,
      routingConfig: routing,
      groupsRepo: { rateMultiplier: () => 1 },
    })
    await handler.handleProtocol(
      {
        method: 'POST',
        url: '/v1/messages',
        headers: { authorization: 'Bearer downstream-fixture-key', 'user-agent': 'actual-api-client/1.0', ...headers },
        apiKeyKind: 'managed',
        apiKeyRecord: { id: 'fixture-key', category: 'api' },
        once() {},
        off() {},
      },
      response,
      protocol,
      '/v1/messages',
    )
    return response
  }
  return { invoke, received, charges }
}

const body = {
  model: 'claude-sonnet-4-6',
  max_tokens: 16,
  stream: false,
  system: [
    { type: 'text', text: 'Caller instructions and real /work/project path.', cache_control: { type: 'ephemeral' } },
  ],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'A fresh unrelated request.' }] }],
  tools: [{ name: 'lookup', description: 'Client tool', input_schema: { type: 'object', properties: {} } }],
  metadata: {
    user_id: JSON.stringify({
      device_id: 'a'.repeat(64),
      account_uuid: '',
      session_id: '67bc77ed-2aff-499f-994e-a8aa89187649',
    }),
  },
}

test('isolated API passthrough preserves request/session/tool/cache fields and actual headers', async (t) => {
  const { invoke, received } = await fixture(t, true)
  const response = await invoke(body, {
    headers: {
      'anthropic-beta': 'caller-beta',
      'x-client-request-id': 'actual-caller-request',
      cookie: 'private-cookie',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(received.length, 1)
  assert.deepEqual(JSON.parse(received[0].body), { ...body, stream: true })
  const headers = received[0].headers
  assert.equal(headers['user-agent'], 'actual-api-client/1.0')
  assert.equal(headers['x-client-request-id'], 'actual-caller-request')
  assert.equal(headers['anthropic-beta'], 'caller-beta')
  assert.equal(headers.authorization, 'Bearer upstream-fixture-key')
  assert.ok(!JSON.stringify(headers).includes('downstream-fixture-key'))
  assert.ok(!JSON.stringify(headers).includes('private-cookie'))
  const second = {
    ...body,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Other user; no supplied prior history.' }] }],
    metadata: { user_id: 'second-user-session' },
  }
  assert.equal((await invoke(second)).status, 200)
  assert.deepEqual(JSON.parse(received[1].body), { ...second, stream: true })
  assert.ok(!received[1].body.includes(body.metadata.user_id))
})

test('default API behavior retains existing persona and token floor', async (t) => {
  const { invoke, received } = await fixture(t, false)
  assert.equal((await invoke(body)).status, 200)
  const forwarded = JSON.parse(received[0].body)
  assert.equal(forwarded.max_tokens, 128)
  assert.notDeepEqual(forwarded.system, body.system)
  assert.equal(received[0].headers['user-agent'], undefined)
})

test('raw relay profile rejects another wire protocol before dispatch', async (t) => {
  const { invoke, received } = await fixture(t, true)
  assert.equal((await invoke(body, { protocol: 'openai.chat' })).status, 400)
  assert.equal(received.length, 0)
})

test('header passthrough is an allowlist and never synthesizes client identity', () => {
  assert.deepEqual(anthropicClientHeaders(null), {})
  assert.deepEqual(
    anthropicClientHeaders({
      'x-cc-atis': 'actual-signature',
      'x-stainless-runtime': 'node',
      authorization: 'secret',
      'x-api-key': 'secret',
      cookie: 'secret',
      'x-forwarded-for': 'private-ip',
      'x-internal-token': 'secret',
    }),
    { 'x-cc-atis': 'actual-signature', 'x-stainless-runtime': 'node' },
  )
})

test('independent telemetry ingress rejects unsupported delivery while default remains unchanged', () => {
  for (const pathname of [
    '/event_logging/batch',
    '/api/eval/feedback',
    '/api/claude_code/metrics',
    '/api/claude_code/organizations/metrics_enabled',
  ]) {
    assert.ok(isTelemetryPath(pathname))
    assert.equal(telemetryIngressResponse(pathname).status, 200)
    const rejected = telemetryIngressResponse(pathname, 'reject')
    assert.equal(rejected.status, 501)
    assert.equal(rejected.body.error.code, 'telemetry_passthrough_unsupported')
    assert.equal(rejected.body.metrics_logging_enabled, undefined)
  }
  assert.throws(() => telemetryIngressResponse('/event_logging/batch', 'typo'))
})

test('isolated API billing keeps actual cache TTL buckets rather than the panel default', async (t) => {
  const { invoke, charges } = await fixture(t, true)
  assert.equal((await invoke(body)).status, 200)
  assert.equal(charges.length, 1)
  assert.deepEqual(charges[0].cache_creation, { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 3 })
})

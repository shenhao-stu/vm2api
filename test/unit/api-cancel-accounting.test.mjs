import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

const usage = { input_tokens: 3, output_tokens: 0, cache_creation_input_tokens: 7, cache_read_input_tokens: 11 }
const wire = (event) => `data: ${JSON.stringify(event)}\n\n`

async function cancelledRequest(t, { terminal = true, timeout = false, alreadyGone = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-cancel-'))
  fs.mkdirSync(path.join(root, 'run'))
  const routing = { compatibility: {}, failover: {} }
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  let attempts = 0,
    releases = 0
  const records = [],
    charges = []
  const kernel = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    attempts++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(
      wire({
        type: 'message_start',
        message: {
          type: 'message',
          id: 'msg_fixture',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [],
          usage,
        },
      }),
    )
    if (timeout) return
    await new Promise((resolve) => setTimeout(resolve, 50))
    res.end(
      terminal
        ? wire({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 19 } }) +
            wire({ type: 'message_stop' })
        : '',
    )
  })
  await new Promise((resolve) => kernel.listen(path.join(root, 'run/api-kernel.sock'), resolve))
  t.after(async () => {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const res = new EventEmitter()
  Object.assign(res, {
    statusCode: 200,
    headersSent: false,
    destroyed: alreadyGone,
    write() {
      if (!this.destroyed) {
        this.destroyed = true
        this.emit('close')
      }
    },
    end() {
      this.writableFinished = true
      this.emit('finish')
    },
  })
  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    url: '/v1/messages',
    headers: {},
    apiKeyKind: 'managed',
    apiKeyRecord: { id: 'fixture', category: 'api' },
  })
  const handler = createHandleProtocol({
    json: (_res, status, value) => Object.assign(res, { statusCode: status, body: value }),
    writeSSEHeaders: () => {
      res.headersSent = true
    },
    requireAuth: () => true,
    readBody: async () => ({
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      stream: true,
      messages: [{ role: 'user', content: 'synthetic cancellation fixture' }],
    }),
    cfg: {
      api_passthrough: true,
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1048576, upstream_timeout_ms: timeout ? 120 : 2000 },
      paths: { data: root, project: root },
    },
    requestLog: {
      start: () => ({ request_id: 'cancel-fixture', t0: Date.now() }),
      finish: (_ctx, row) => records.push(structuredClone(row)),
    },
    stickyRouter: {},
    accountQuota: {},
    apiEndpointStore: {},
    apiKeyStore: {
      acquire: () => ({ ok: true }),
      release: () => releases++,
      recordUsage: (_key, value) => charges.push(value),
    },
    apiScheduler: {
      pick: () => ({
        ok: true,
        endpoint: { id: 'ep', kind: 'custom', protocol: 'anthropic', base_url: 'https://fixture.invalid' },
        key: { id: 'upstream-fixture', api_key: 'synthetic' },
        upstream_model: 'claude-sonnet-5-5',
      }),
    },
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    groupsRepo: { rateMultiplier: () => 1 },
    routingConfigPath: routingFile,
    routingConfig: routing,
  })
  const started = Date.now()
  await handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages')
  return { records, charges, attempts, releases, elapsed: Date.now() - started }
}

test('native API cancellation drains terminal usage and records/bills exactly once', async (t) => {
  const r = await cancelledRequest(t)
  assert.equal(r.attempts, 1)
  assert.equal(r.releases, 1)
  assert.equal(r.records.length, 1)
  assert.equal(r.records[0].status, 499)
  assert.equal(r.records[0].final_state, 'cancelled')
  assert.equal(r.records[0].account_id, 'upstream-fixture')
  assert.deepEqual(r.records[0].usage, { ...usage, output_tokens: 19 })
  assert.deepEqual(r.charges, [{ ...usage, output_tokens: 19 }])
})

test('a client already gone before dispatch cannot start a model request', async (t) => {
  const r = await cancelledRequest(t, { alreadyGone: true })
  assert.equal(r.attempts, 0)
  assert.equal(r.releases, 1)
  assert.equal(r.records[0].status, 499)
  assert.equal(r.records[0].attempt_count, 0)
  assert.equal(r.charges.length, 0)
})

test('missing terminal usage is retained as incomplete, never fabricated or fully billed', async (t) => {
  const r = await cancelledRequest(t, { terminal: false })
  assert.equal(r.attempts, 1)
  assert.equal(r.records[0].final_state, 'cancelled_incomplete')
  assert.equal(r.records[0].usage.output_tokens, 0)
  assert.equal(r.charges.length, 0)
})

test('cancel drain remains bounded by the existing upstream deadline', async (t) => {
  const r = await cancelledRequest(t, { timeout: true })
  assert.equal(r.attempts, 1)
  assert.equal(r.releases, 1)
  assert.equal(r.records[0].status, 499)
  assert.equal(r.records[0].final_state, 'cancelled_incomplete')
  assert.equal(r.charges.length, 0)
  assert.ok(r.elapsed < 1500)
})

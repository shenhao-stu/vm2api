import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { refusalFingerprint } from '../../src/lib/core/refusal-guard.mjs'

const base = {
  model: 'claude-haiku-4-5',
  messages: [{ role: 'user', content: 'local admission fixture' }],
  max_tokens: 8,
}
const cases = [
  { name: 'missing model', body: { ...base, model: undefined }, code: 'model_required' },
  { name: 'empty messages', body: { ...base, messages: [] }, code: 'invalid_messages' },
  { name: 'negative token budget', body: { ...base, max_tokens: -1 }, code: 'invalid_field' },
  { name: 'unsupported provider', body: { ...base, model: 'grok-unsupported-fixture' }, code: 'model_not_supported' },
  { name: 'unknown Claude model', body: { ...base, model: 'claude-nonexistent-fixture' }, code: 'model_not_supported' },
  { name: 'remembered upstream refusal', body: base, refusal: true, code: 'refusal_guard' },
]
for (const item of cases) {
  test(`local admission: ${item.name} returns an error without dispatching upstream`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-admission-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    let dispatches = 0
    let logged
    const noDispatch = () => {
      dispatches++
      throw new Error('unexpected_upstream_dispatch')
    }
    const response = Object.assign(new EventEmitter(), { headersSent: false, writableFinished: false })
    const req = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/v1/messages',
      headers: { 'user-agent': 'local-admission-test' },
      apiKeyKind: 'master',
    })
    const fingerprint = refusalFingerprint(base, base)
    const handler = createHandleProtocol({
      json: (res, status, body) => {
        res.statusCode = status
        res.body = body
        res.writableFinished = true
        res.emit('finish')
      },
      writeSSEHeaders: noDispatch,
      readBody: async () => structuredClone(item.body),
      requireAuth: () => true,
      cfg: {
        rewrite: { enabled: false },
        intercept: { rules: [] },
        distill: { enabled: false },
        limits: { max_body_bytes: 4096 },
        paths: { data: root, project: root },
      },
      requestLog: {
        start: () => ({ request_id: item.name }),
        finish: (_, value) => {
          logged = value
        },
      },
      stats: { errors: 0, requests: 0, by_route: {} },
      routingConfig: { compatibility: {} },
      routingConfigPath: path.join(root, 'routing.json'),
      settings: { get: (_, fallback) => fallback },
      refusalGuards: {
        get: (key) =>
          item.refusal && key === fingerprint
            ? { fingerprint, error_message: 'upstream Usage Policy refusal', model: base.model }
            : null,
      },
      refusalDevices: { get: () => null, upsert: () => {} },
      failoverRunner: { run: noDispatch },
      apiScheduler: { pick: noDispatch },
      apiKeyStore: { acquire: noDispatch },
      accountQuota: {},
      stickyRouter: {},
      groupsRepo: { rateMultiplier: () => 1 },
    })
    await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
    assert.equal(dispatches, 0, item.name)
    assert.equal(response.statusCode, 400, item.name)
    assert.equal(response.body.error.code, item.code, item.name)
    assert.ok(logged, item.name)
    assert.equal(logged.attempt_count, 0, 'a locally rejected request records zero upstream attempts')
  })
}

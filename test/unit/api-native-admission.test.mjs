import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runApiInference } from '../../src/lib/pool/api-protocol.mjs'
import { ApiScheduler } from '../../src/lib/pool/api-scheduler.mjs'

test('native 429 applies cooldown only to account-level failures', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-admission-'))
  fs.mkdirSync(path.join(root, 'run'))
  let response
  let forwards = 0
  const kernel = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      forwards++
      res.writeHead(429, { 'content-type': 'application/json', ...response.headers })
      res.end(JSON.stringify(response.body))
    })
  })
  await new Promise((resolve) => kernel.listen(path.join(root, 'run/api-kernel.sock'), resolve))
  t.after(async () => {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const model = 'claude-test'
  for (const [code, passthrough, headers, details, shouldCool] of [
    ['session_busy', true, {}, null, false],
    ['native_session_capacity', true, {}, null, false],
    ['native_memory_pressure', true, {}, null, false],
    ['native_rate_limit', true, {}, null, true],
    ['session_busy', false, {}, null, true],
    ['native_rate_limit', true, { 'retry-after': 'Sun, 06 Nov 2095 08:49:37 GMT' }, null, true],
    ['session_busy', true, { 'retry-after': '42' }, null, true],
    ['session_busy', true, { 'anthropic-ratelimit-requests-reset': '2099-01-01T00:00:00Z' }, null, true],
    ['session_busy', true, {}, { upstream_type: 'rate_limit_error' }, true],
  ]) {
    const key = { id: 'key', api_key: 'fixture' }
    const endpoint = {
      id: 'endpoint',
      kind: 'custom',
      protocol: 'anthropic',
      base_url: 'https://fixture.invalid',
      models: [{ name: model, alias: model }],
      api_key_entries: [key],
    }
    const scheduler = new ApiScheduler()
    const store = {
      listRaw: () => [endpoint],
      setKeyCooldown: (_, until) => {
        key.cooldown_until = until
      },
    }
    scheduler.reload(store.listRaw())
    response = {
      headers,
      body: { type: 'error', error: { type: 'api_error', code, message: code, ...(details && { details }) } },
    }
    const before = forwards
    const result = await runApiInference({
      cfg: { paths: { data: root }, api_passthrough: passthrough },
      scheduler,
      store,
      protocol: 'anthropic.messages',
      convertedBody: { model, messages: [{ role: 'user', content: 'test' }] },
    })
    assert.equal(result.status, 429)
    assert.equal(forwards, before + 1)
    assert.equal(scheduler.pick(model).ok, !shouldCool, JSON.stringify([code, passthrough, headers, details]))
  }
})

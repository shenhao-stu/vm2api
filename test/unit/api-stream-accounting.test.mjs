import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runApiInference } from '../../src/lib/pool/api-protocol.mjs'

const usage = {
  input_tokens: 3,
  output_tokens: 0,
  cache_creation_input_tokens: 1314,
  cache_read_input_tokens: 3016,
  cache_creation: { ephemeral_5m_input_tokens: 1314, ephemeral_1h_input_tokens: 0 },
}
const start = { type: 'message_start', message: { usage } }
const delta = { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }
const stop = { type: 'message_stop' }

async function stream(t, events) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-accounting-'))
  fs.mkdirSync(path.join(root, 'run'))
  const wire = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  let attempts = 0
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      attempts++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(wire)
    })
  })
  await new Promise((resolve) => server.listen(path.join(root, 'run/api-kernel.sock'), resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  let received = ''
  const res = {
    headersSent: false,
    write: (value) => {
      received += value
    },
  }
  const result = await runApiInference({
    cfg: { paths: { data: root } },
    res,
    protocol: 'anthropic.messages',
    clientStream: true,
    deliveryMode: 'realtime',
    convertedBody: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'test' }] },
    inbound: {},
    converters: {
      writeSSEHeaders: () => {
        res.headersSent = true
      },
    },
    scheduler: {
      pick: () => ({
        ok: true,
        endpoint: { id: 'ep', kind: 'custom', protocol: 'anthropic', base_url: 'https://fixture.invalid' },
        key: { id: 'key', api_key: 'fixture' },
        upstream_model: 'claude-sonnet-4-6',
      }),
    },
  })
  assert.equal(attempts, 1)
  return { result, received, wire }
}

test('Anthropic API stream returns actual input/cache/output usage without changing the wire', async (t) => {
  const { result, received, wire } = await stream(t, [start, delta, stop])
  assert.equal(result.ok, true)
  assert.equal(result.terminalState, 'verified')
  assert.deepEqual(result.usage, { ...usage, output_tokens: 12 })
  assert.equal(received, wire)
})

test('text mentioning message_stop cannot turn a truncated realtime API stream into success', async (t) => {
  const text = {
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: 'The string message_stop is only text.' },
  }
  const { result } = await stream(t, [start, text])
  assert.equal(result.ok, false)
  assert.equal(result.terminalState, 'incomplete')
  assert.deepEqual(result.usage, usage)
})

test('an API stream error remains a failure even if followed by a terminal frame', async (t) => {
  const error = { type: 'error', error: { type: 'overloaded_error', status: 503, message: 'capacity' } }
  const { result } = await stream(t, [start, error, stop])
  assert.equal(result.ok, false)
  assert.equal(result.status, 503)
  assert.equal(result.terminalState, 'rejected')
  assert.deepEqual(result.usage, usage)
})

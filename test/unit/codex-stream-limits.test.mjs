import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  streamGoWorker,
  normalizeWorkerStreamLimits,
  WORKER_STREAM_LIMITS,
} from '../../src/lib/transport/go-worker-client.mjs'

const frame = (event) => `data: ${JSON.stringify(event)}\n\n`
const start = frame({ type: 'message_start', message: { content: [] } })
const block = frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
const delta = (text) => frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
const stop =
  frame({ type: 'content_block_stop', index: 0 }) +
  frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) +
  frame({ type: 'message_stop' })

async function within(promise, ms = 1500) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('socket did not close promptly')), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function fixture(t, handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wlim-'))
  const socket = path.join(root, 'worker.sock')
  const token = path.join(root, 'token')
  fs.writeFileSync(token, 'fixture-not-secret', { mode: 0o600 })
  let requests = 0,
    closedResolve
  const cancellations = [],
    inferenceIds = []
  const closed = new Promise((resolve) => {
    closedResolve = resolve
  })
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    const parts = []
    for await (const chunk of req) parts.push(chunk)
    const payload = JSON.parse(Buffer.concat(parts).toString() || '{}')
    if (req.url === '/internal/v1/cancel') {
      cancellations.push(payload.request_id)
      res.end('{"ok":true}')
      return
    }
    requests++
    inferenceIds.push(payload.request_id)
    res.once('close', closedResolve)
    res.setHeader('content-type', 'text/event-stream')
    try {
      await handler(res)
    } catch (error) {
      if (!res.destroyed) res.destroy(error)
    }
  })
  server.on('connection', (value) => {
    sockets.add(value)
    value.once('close', () => sockets.delete(value))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  t.after(async () => {
    for (const value of sockets) value.destroy()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const exec = {
    vmId: 'vm-fixture',
    homeDir: root,
    vm: { runtime: { worker_socket: socket, worker_token_file: token } },
  }
  return {
    closed,
    requests: () => requests,
    cancellations,
    inferenceIds,
    run: (options = {}) =>
      streamGoWorker({
        exec,
        requestPath: '/internal/v1/codex/responses',
        envelope: { body: { stream: true } },
        timeoutMs: 1000,
        ...options,
      }),
  }
}

test('worker stream limits use safe defaults and bound invalid/oversized overrides', () => {
  assert.deepEqual(normalizeWorkerStreamLimits(), WORKER_STREAM_LIMITS)
  assert.deepEqual(normalizeWorkerStreamLimits({ lineBytes: 9, eventBytes: 20, precommitBytes: 30 }), {
    lineBytes: 9,
    eventBytes: 20,
    precommitBytes: 30,
  })
  for (const value of [null, 0, -1, 1.5, '10', Infinity, NaN])
    assert.equal(normalizeWorkerStreamLimits({ lineBytes: value }).lineBytes, WORKER_STREAM_LIMITS.lineBytes)
  assert.equal(normalizeWorkerStreamLimits({ eventBytes: 1024 ** 3 }).eventBytes, 64 * 1024 ** 2)
})

test('a local frame limit explicitly cancels the named remote job even without an abort signal', async (t) => {
  const f = await fixture(t, async (res) => {
    res.write('x'.repeat(33))
  })
  const result = await f.run({ streamLimits: { lineBytes: 32 } })
  assert.equal(result.body.error.code, 'worker_stream_limit')
  assert.deepEqual(f.cancellations, f.inferenceIds)
  assert.equal(f.cancellations.length, 1)
})

test('downstream drain timeout cancels exactly one remote job and never becomes a transport retry', async (t) => {
  const f = await fixture(t, async (res) => {
    res.write(start + block + delta('hello'))
  })
  const result = await f.run({
    onEvent: async () => {
      throw Object.assign(new Error('downstream write timed out'), { code: 'downstream_write_timeout' })
    },
  })
  assert.equal(result.body.error.code, 'downstream_write_timeout')
  assert.equal(result.transportError, false)
  assert.equal(result.committed, true)
  assert.equal(result.terminalState, 'incomplete')
  assert.deepEqual(f.cancellations, f.inferenceIds)
  assert.equal(f.cancellations.length, 1)
})

test('an unterminated line is bounded across chunks and the upstream socket closes', async (t) => {
  const marker = 'fixture-private-prefix'
  const f = await fixture(t, async (res) => {
    res.write(':' + marker)
    await delay(5)
    res.write('x'.repeat(32))
    await delay(5)
    res.write('x'.repeat(32))
  })
  const lines = []
  const result = await f.run({ streamLimits: { lineBytes: 48 }, onEvent: (line) => lines.push(line) })
  assert.equal(result.ok, false)
  assert.equal(result.status, 502)
  assert.equal(result.body.error.code, 'worker_stream_limit')
  assert.equal(result.terminalState, 'rejected')
  assert.equal(result.committed, false)
  assert.equal(result.transportError, false)
  assert.deepEqual(lines, [])
  assert.ok(!JSON.stringify(result).includes(marker))
  await within(f.closed)
})

test('precommit prefix limits include comment and blank lines', async (t) => {
  const f = await fixture(t, (res) => {
    res.write(':'.padEnd(41, 'x') + '\n\n' + ':'.padEnd(41, 'y') + '\n\n')
  })
  const lines = []
  const result = await f.run({
    streamLimits: { lineBytes: 64, precommitBytes: 80 },
    onEvent: (line) => lines.push(line),
  })
  assert.equal(result.body.error.code, 'worker_stream_limit')
  assert.equal(result.committed, false)
  assert.deepEqual(lines, [])
  await within(f.closed)
})

test('precommit prefix is measured in UTF-8 bytes rather than string characters', async (t) => {
  const f = await fixture(t, (res) => res.write(':你好🙂\n'))
  const result = await f.run({ streamLimits: { precommitBytes: 10 } })
  assert.equal(result.body.error.code, 'worker_stream_limit')
  await within(f.closed)
})

test('multi-line event data cannot exceed the event budget using individually small lines', async (t) => {
  const f = await fixture(t, (res) => {
    res.write('data: {"value":"\n')
    res.write('data: ' + 'x'.repeat(40) + '\n')
    res.write('data: ' + 'y'.repeat(40) + '\n')
  })
  const result = await f.run({ streamLimits: { lineBytes: 64, eventBytes: 70, precommitBytes: 256 } })
  assert.equal(result.body.error.code, 'worker_stream_limit')
  assert.equal(result.committed, false)
  await within(f.closed)
})

test('an unterminated final data line also obeys the event budget', async (t) => {
  const f = await fixture(t, (res) => res.end('data: {"value":"' + 'x'.repeat(80) + '"}'))
  const result = await f.run({ streamLimits: { lineBytes: 256, eventBytes: 64, precommitBytes: 512 } })
  assert.equal(result.body.error.code, 'worker_stream_limit')
  assert.equal(result.committed, false)
})

test('a limit after output retains committed/incomplete and never forwards the oversized frame', async (t) => {
  const f = await fixture(t, async (res) => {
    res.write(start + block + delta('visible'))
    await delay(5)
    res.write(delta('z'.repeat(1024)))
  })
  const lines = []
  const result = await f.run({ streamLimits: { lineBytes: 256, eventBytes: 256 }, onEvent: (line) => lines.push(line) })
  assert.equal(result.ok, false)
  assert.equal(result.body.error.code, 'worker_stream_limit')
  assert.equal(result.committed, true)
  assert.equal(result.terminalState, 'incomplete')
  assert.ok(lines.some((line) => line.includes('visible')))
  assert.ok(!lines.some((line) => line.includes('z'.repeat(100))))
  assert.equal(f.requests(), 1)
  await within(f.closed)
})

test('many valid frames in one chunk may exceed per-frame limits in aggregate and keep trailers', async (t) => {
  const content = 'text'.repeat(10)
  const payload = start + block + Array.from({ length: 300 }, () => delta(content)).join('') + stop
  const f = await fixture(t, (res) => {
    res.setHeader('trailer', 'x-usage, x-stop-reason')
    res.write(payload)
    res.addTrailers({
      'x-usage': JSON.stringify({ input_tokens: 12, output_tokens: 300 }),
      'x-stop-reason': 'end_turn',
    })
    res.end()
  })
  const result = await f.run({
    streamLimits: { lineBytes: 256, eventBytes: 256, precommitBytes: 128 },
    onEvent: () => {},
  })
  assert.equal(result.ok, true)
  assert.equal(result.terminalState, 'verified')
  assert.equal(result.usage.input_tokens, 12)
  assert.equal(result.usage.output_tokens, 300)
  assert.equal(result.body.content[0].text, content.repeat(300))
  assert.equal(result.stopReason, 'end_turn')
})

for (const requestPath of ['/internal/v1/codex/responses', '/internal/v1/messages']) {
  test(`split UTF-8 codepoints survive ${requestPath}`, async (t) => {
    const text = '你好🙂'
    const raw = Buffer.from(delta(text))
    const index = raw.indexOf(Buffer.from('你')) + 1
    const f = await fixture(t, async (res) => {
      res.write(start + block)
      res.write(raw.subarray(0, index))
      await delay(5)
      res.write(raw.subarray(index, index + 4))
      await delay(5)
      res.write(raw.subarray(index + 4))
      res.end(stop)
    })
    const lines = []
    const result = await f.run({ requestPath, onEvent: (line) => lines.push(line) })
    assert.equal(result.ok, true)
    assert.equal(result.body.content[0].text, text)
    assert.ok(lines.some((line) => line.includes(text)))
  })
}

test('normal image-sized JSON and complete tool parameters remain unchanged', async (t) => {
  const input = { image: 'a'.repeat(12 * 1024), query: 'fixture' }
  const f = await fixture(t, (res) => {
    res.write(start)
    res.write(
      frame({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool-fixture', name: 'inspect_image', input: {} },
      }),
    )
    res.write(
      frame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      }),
    )
    res.end(stop)
  })
  const result = await f.run({ onEvent: () => {} })
  assert.equal(result.ok, true)
  assert.deepEqual(result.body.content[0].input, input)
})

test('abort during an unfinished bounded frame promptly closes the upstream', async (t) => {
  let sentResolve
  const sent = new Promise((resolve) => {
    sentResolve = resolve
  })
  const f = await fixture(t, (res) => {
    res.write('data: {"unfinished":')
    sentResolve()
  })
  const controller = new AbortController()
  const pending = f.run({ signal: controller.signal })
  await sent
  controller.abort()
  const result = await within(pending)
  assert.equal(result.body.error.code, 'client_cancelled')
  await within(f.closed)
})

test('Claude default streaming retains its precommit capacity and timing without Codex observations', async (t) => {
  const f = await fixture(t, (res) =>
    res.end(':' + 'x'.repeat(5 * 1024 * 1024) + '\n\n' + start + block + delta('claude-fixture') + stop),
  )
  const result = await f.run({ requestPath: '/internal/v1/messages' })
  assert.equal(result.ok, true)
  assert.equal(result.terminalState, 'verified')
  assert.equal(result.streamObservation, undefined)
  assert.ok(Number.isFinite(result.ttftMs))
  assert.equal(f.cancellations.length, 0)
})

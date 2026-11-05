/**
 * writeWithBackpressure: exactly-once writes, real drain waits, prompt failure
 * on close/abort/timeout, and listener/timer cleanup on every path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import { writeChunkedWithBackpressure, writeWithBackpressure } from '../../src/lib/http/write-backpressure.mjs'

const PAYLOAD = 'héllo-多字节-🙂-payload'
const BUFFER_PAYLOAD = Buffer.from('多字节✓utf8', 'utf8')

class FakeResponse extends EventEmitter {
  constructor({ writeResult = true, throwError = null, state = {} } = {}) {
    super()
    this.writeResult = writeResult
    this.throwError = throwError
    this.writes = []
    Object.assign(this, { destroyed: false, writableEnded: false, writableFinished: false }, state)
  }

  write(chunk) {
    if (this.throwError) throw this.throwError
    this.writes.push(chunk)
    return this.writeResult
  }

  listenerSummary() {
    return {
      drain: this.listenerCount('drain'),
      close: this.listenerCount('close'),
      error: this.listenerCount('error'),
    }
  }
}

test('resolves immediately when write returns true, writing exactly once', async () => {
  const res = new FakeResponse({ writeResult: true })
  await writeWithBackpressure(res, PAYLOAD)
  assert.equal(res.writes.length, 1)
  assert.equal(res.writes[0], PAYLOAD)
  assert.deepEqual(res.listenerSummary(), { drain: 0, close: 0, error: 0 })

  // A late drain must not cause another write or a second settle.
  res.emit('drain')
  assert.equal(res.writes.length, 1)
})

test('treats an undefined write result from a bare stub as accepted', async () => {
  const stub = {
    writes: [],
    write(chunk) {
      this.writes.push(chunk)
      return undefined
    },
  }
  await writeWithBackpressure(stub, BUFFER_PAYLOAD)
  assert.equal(stub.writes.length, 1)
  assert.deepEqual(stub.writes[0], BUFFER_PAYLOAD)
  assert.equal(Buffer.from(stub.writes[0]).toString('utf8'), '多字节✓utf8')
})

test('waits for drain when write returns false and keeps bytes intact', async () => {
  const res = new FakeResponse({ writeResult: false })
  const order = []
  const pending = writeWithBackpressure(res, BUFFER_PAYLOAD).then(() => {
    order.push('resolved')
  })
  order.push('write-returned-false')

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['write-returned-false'], 'must not resolve before drain')
  res.emit('drain')
  await pending

  assert.deepEqual(order, ['write-returned-false', 'resolved'])
  assert.equal(res.writes.length, 1)
  assert.equal(Buffer.from(res.writes[0]).toString('utf8'), '多字节✓utf8')
  assert.deepEqual(res.listenerSummary(), { drain: 0, close: 0, error: 0 })

  // Drain emitted again after settling is a no-op.
  res.emit('drain')
  assert.equal(res.writes.length, 1)
})

test('preserves write order across sequential backpressured writes', async () => {
  const res = new FakeResponse({ writeResult: false })
  const chunks = []
  for (const chunk of ['first-多', 'second-字节', 'third-🙂']) {
    const pending = writeWithBackpressure(res, chunk)
    setImmediate(() => res.emit('drain'))
    await pending
    chunks.push(chunk)
  }
  assert.deepEqual(res.writes, chunks)
  assert.deepEqual(res.writes, ['first-多', 'second-字节', 'third-🙂'])
})

test('rejects with client_cancelled when the stream closes before drain', async () => {
  const res = new FakeResponse({ writeResult: false })
  const pending = writeWithBackpressure(res, PAYLOAD)
  await new Promise((resolve) => setImmediate(resolve))
  res.emit('close')

  await assert.rejects(pending, (err) => {
    assert.equal(err.code, 'client_cancelled')
    assert.equal(err.message.includes(PAYLOAD), false)
    return true
  })
  assert.deepEqual(res.listenerSummary(), { drain: 0, close: 0, error: 0 })
  // A late drain cannot resurrect a settled write.
  res.emit('drain')
  assert.equal(res.writes.length, 1)
})

test('rejects with client_cancelled when the caller aborts while draining', async () => {
  const res = new FakeResponse({ writeResult: false })
  const controller = new AbortController()
  const pending = writeWithBackpressure(res, PAYLOAD, { signal: controller.signal })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()

  await assert.rejects(pending, (err) => {
    assert.equal(err.code, 'client_cancelled')
    return true
  })
  assert.deepEqual(res.listenerSummary(), { drain: 0, close: 0, error: 0 })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('rejects with client_cancelled without writing when already aborted', async () => {
  const res = new FakeResponse({ writeResult: true })
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    writeWithBackpressure(res, PAYLOAD, { signal: controller.signal }),
    (err) => err.code === 'client_cancelled',
  )
  assert.equal(res.writes.length, 0)
  assert.deepEqual(res.listenerSummary(), { drain: 0, close: 0, error: 0 })
})

test('rejects with client_cancelled without writing when already gone', async () => {
  for (const state of [{ destroyed: true }, { writableEnded: true }, { writableFinished: true }]) {
    const res = new FakeResponse({ writeResult: true, state })
    await assert.rejects(writeWithBackpressure(res, PAYLOAD), (err) => err.code === 'client_cancelled')
    assert.equal(res.writes.length, 0)
    assert.deepEqual(res.listenerSummary(), { drain: 0, close: 0, error: 0 })
  }
})

test('rejects with downstream_write_timeout and never leaks the payload', async () => {
  const res = new FakeResponse({ writeResult: false })
  // The helper's timer is unref'd on purpose (a real socket keeps the loop
  // alive), so the test itself must hold the event loop open.
  const keepAlive = setTimeout(() => {}, 1000)
  const started = Date.now()
  try {
    await assert.rejects(writeWithBackpressure(res, PAYLOAD, { timeoutMs: 20 }), (err) => {
      assert.equal(err.code, 'downstream_write_timeout')
      assert.equal(err.message.includes(PAYLOAD), false)
      assert.match(err.message, /20ms/)
      return true
    })
  } finally {
    clearTimeout(keepAlive)
  }
  assert.ok(Date.now() - started >= 15)
  assert.deepEqual(res.listenerSummary(), { drain: 0, close: 0, error: 0 })
  assert.equal(res.writes.length, 1, 'the chunk is written once, not retried')
})

test('propagates a synchronous throw from write and cleans up', async () => {
  const boom = new Error('write exploded')
  const res = new FakeResponse({ throwError: boom })

  await assert.rejects(writeWithBackpressure(res, PAYLOAD), (err) => {
    assert.equal(err, boom)
    assert.equal(err.message.includes(PAYLOAD), false)
    return true
  })
  assert.equal(res.writes.length, 0)
  assert.deepEqual(res.listenerSummary(), { drain: 0, close: 0, error: 0 })
})

test('maps disconnect-style write throws to client_cancelled with cause', async () => {
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  const res = new FakeResponse({ throwError: epipe })

  await assert.rejects(writeWithBackpressure(res, PAYLOAD), (err) => {
    assert.equal(err.code, 'client_cancelled')
    assert.equal(err.cause, epipe)
    return true
  })
  assert.deepEqual(res.listenerSummary(), { drain: 0, close: 0, error: 0 })
})

test('rejects with the stream error emitted while waiting for drain', async () => {
  const res = new FakeResponse({ writeResult: false })
  const socketError = new Error('socket hung up')
  const pending = writeWithBackpressure(res, PAYLOAD)
  await new Promise((resolve) => setImmediate(resolve))
  res.emit('error', socketError)

  await assert.rejects(pending, (err) => {
    assert.equal(err, socketError)
    return true
  })
  assert.deepEqual(res.listenerSummary(), { drain: 0, close: 0, error: 0 })
})

test('handles a drain emitted synchronously inside write', async () => {
  const res = new EventEmitter()
  res.writes = []
  res.write = function write(chunk) {
    this.writes.push(chunk)
    this.emit('drain')
    return false
  }

  await writeWithBackpressure(res, PAYLOAD, { timeoutMs: 20 })
  assert.equal(res.writes.length, 1)
  assert.deepEqual(
    { drain: res.listenerCount('drain'), close: res.listenerCount('close'), error: res.listenerCount('error') },
    { drain: 0, close: 0, error: 0 },
  )
})

test('chunks a large logical payload without changing byte order', async () => {
  const res = new FakeResponse({ writeResult: true })
  const payload = Buffer.alloc(32 * 1024 * 2 + 17)
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251

  await writeChunkedWithBackpressure(res, payload)

  assert.equal(res.writes.length, 3)
  assert.ok(res.writes.every((chunk) => chunk.length <= 32 * 1024))
  assert.deepEqual(Buffer.concat(res.writes), payload)
  assert.equal(new Set(res.writes).size, 3, 'each chunk is written once')
})

test('allows a continuously draining large payload to exceed one write buffer', async () => {
  const written = []
  const res = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      written.push(Buffer.from(chunk))
      setTimeout(done, 5)
    },
  })
  const payload = Buffer.alloc(32 * 1024 * 40, 0x5a)
  const started = Date.now()
  await writeChunkedWithBackpressure(res, payload, { timeoutMs: 100, maxDurationMs: 2000 })
  assert.ok(Date.now() - started > 100, 'the event may take longer than one stalled-chunk deadline')
  assert.deepEqual(Buffer.concat(written), payload)
  assert.equal(written.length, 40)
})

test('a large payload that never drains still has a bounded stall deadline', async () => {
  const res = new FakeResponse({ writeResult: false })
  res.writableLength = 32768
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(writeChunkedWithBackpressure(res, Buffer.alloc(96 * 1024), { timeoutMs: 20 }), (err) => {
      assert.equal(err.code, 'downstream_write_timeout')
      assert.match(err.message, /20ms/)
      assert.match(err.message, /\[write_offset=0 write_bytes=98304 queued=32768\]/)
      assert.equal(err.message.includes(PAYLOAD), false)
      return true
    })
  } finally {
    clearTimeout(keepAlive)
  }
  assert.equal(res.writes.length, 1, 'a blocked chunk is not retried')
})

test('a draining payload still has a separate total duration bound', async () => {
  const res = new FakeResponse({ writeResult: false })
  const keepAlive = setTimeout(() => {}, 1000)
  const drain = setInterval(() => res.emit('drain'), 5)
  try {
    await assert.rejects(
      writeChunkedWithBackpressure(res, Buffer.alloc(32 * 1024 * 100), {
        timeoutMs: 100,
        maxDurationMs: 30,
      }),
      (err) => err.code === 'downstream_write_timeout',
    )
  } finally {
    clearInterval(drain)
    clearTimeout(keepAlive)
  }
  assert.ok(res.writes.length < 100, 'the event must stop before all chunks are queued')
})

test('aborting a chunked payload cancels the current write', async () => {
  const res = new FakeResponse({ writeResult: false })
  const controller = new AbortController()
  const pending = writeChunkedWithBackpressure(res, Buffer.alloc(96 * 1024), {
    signal: controller.signal,
    timeoutMs: 200,
  })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, (err) => err.code === 'client_cancelled')
  assert.equal(res.writes.length, 1)
})

test('closing a chunked payload immediately prevents later writes', async () => {
  const res = new FakeResponse({ writeResult: false })
  const pending = writeChunkedWithBackpressure(res, Buffer.alloc(96 * 1024))
  res.destroyed = true
  res.emit('close')
  await assert.rejects(pending, (err) => err.code === 'client_cancelled')
  res.emit('drain')
  assert.equal(res.writes.length, 1)
})

test('text chunks preserve UTF-8 when a virtual response decodes writes separately', async () => {
  const res = new FakeResponse({ writeResult: true })
  const text = '🙂多字节é'.repeat(100)
  await writeChunkedWithBackpressure(res, text, { chunkBytes: 7 })
  assert.equal(res.writes.map((chunk) => String(chunk)).join(''), text)
  assert.ok(res.writes.every((chunk) => Buffer.byteLength(chunk) <= 7))

  const bytes = Uint8Array.from([0x80, 0xff, 1, 2, 3, 4, 5, 6, 7])
  const raw = new FakeResponse({ writeResult: true })
  await writeChunkedWithBackpressure(raw, bytes.subarray(1, 8), { chunkBytes: 4 })
  assert.deepEqual(Buffer.concat(raw.writes), Buffer.from(bytes.subarray(1, 8)))
})

test('a real HTTP slow reader receives a multi-megabyte event with the terminal frame intact', async (t) => {
  const payload = Buffer.from(
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: 'response.output_item.done',
      item: { type: 'image_generation_call', result: 'A'.repeat(8 * 1024 * 1024) },
    })}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n`,
  )
  let serverFailure
  const server = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    try {
      await writeChunkedWithBackpressure(res, payload, { timeoutMs: 500, maxDurationMs: 10000 })
      res.end()
    } catch (error) {
      serverFailure = error
      res.destroy(error)
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const received = await new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${server.address().port}`, (res) => {
        const chunks = []
        res.on('data', (chunk) => {
          chunks.push(chunk)
          res.pause()
          setTimeout(() => res.resume(), 5)
        })
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      })
      .on('error', reject)
  })
  assert.equal(serverFailure, undefined)
  assert.equal(received.length, payload.length)
  assert.equal(createHash('sha256').update(received).digest('hex'), createHash('sha256').update(payload).digest('hex'))
  assert.ok(received.subarray(-80).toString().endsWith('data: {"type":"response.completed"}\n\n'))
})

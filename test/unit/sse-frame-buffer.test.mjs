import test from 'node:test'
import assert from 'node:assert/strict'
import { createSseFrameBuffer } from '../../src/lib/protocol/sse-frame-buffer.mjs'
import { createDownstreamKeepalive } from '../../src/lib/protocol/stream-keepalive.mjs'

test('a delayed SSE field line stays behind the event boundary while a keepalive is written', () => {
  const chunks = []
  const frames = createSseFrameBuffer()
  const keepalive = createDownstreamKeepalive({
    intervalMs: 60_000,
    userAgent: 'claude-cli/2.1.318',
    write: (chunk) => chunks.push(chunk),
  })
  try {
    keepalive.armAfter(0)
    assert.deepEqual(frames.push('event: content_block_stop'), [])
    keepalive.beat()
    assert.equal(chunks.length, 1)
    const ready = frames.push('data: {"type":"content_block_stop","index":0}\r')
    assert.deepEqual(ready, [])
    for (const frame of frames.push('')) chunks.push(frame.join('\n') + '\n\n')
    const events = chunks.join('').split('\n\n').filter(Boolean)
    assert.equal(events.length, 2)
    assert.ok(events.every((frame) => frame.split('\n').filter((line) => line.startsWith('event:')).length === 1))
    assert.match(events[1], /^event: content_block_stop\ndata: /)
  } finally {
    keepalive.stop()
  }
})

test('multiline data and complete frames retain field ordering and text', () => {
  const frames = createSseFrameBuffer()
  assert.deepEqual(
    frames.push(
      'event: content_block_delta\ndata: {"type":"content_block_delta",\ndata: "text":"response_headers"}\n\n',
    ),
    [['event: content_block_delta', 'data: {"type":"content_block_delta",', 'data: "text":"response_headers"}']],
  )
  assert.deepEqual(frames.push(': heartbeat\n\n'), [[': heartbeat']])
  assert.deepEqual(frames.push('data: {"type":"message_stop"}'), [])
  assert.deepEqual(frames.push(''), [['data: {"type":"message_stop"}']])
  assert.deepEqual(frames.push(''), [])
})

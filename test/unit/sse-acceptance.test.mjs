import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeSse } from '../../scripts/sse-acceptance.mjs'

const start = {
  type: 'message_start',
  message: { id: 'synthetic', role: 'assistant', content: [], usage: { input_tokens: 3 } },
}
const finish = [
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
  { type: 'message_stop' },
]
const block = (text) => ({ type: 'content_block_start', index: 0, content_block: { type: 'text', text } })
const delta = (text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
const wire = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')

test('acceptance includes initial block text as well as deltas', () => {
  const result = analyzeSse(wire([start, block('CHECK_'), delta('PASS'), ...finish]), 'CHECK_PASS')
  assert.equal(result.text, 'CHECK_PASS')
  assert.equal(result.exact_text, true)
  assert.equal(result.legacy_exact_text, false)
  assert.equal(result.stream_complete, true)
})

test('acceptance preserves a response contained entirely in the starting block', () => {
  assert.equal(analyzeSse(wire([start, block('你好'), ...finish]), '你好').exact_text, true)
})

test('ordinary deltas and accounting retain native meanings', () => {
  const result = analyzeSse(wire([start, block(''), delta('PASS'), ...finish]), 'PASS')
  assert.equal(result.exact_text, true)
  assert.equal(result.legacy_exact_text, true)
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 7 })
})

test('CRLF, multiline data, comments and ping do not lose text', () => {
  const raw = wire([start, { type: 'ping' }, block(''), delta('你好'), ...finish])
    .replace('"delta":{"type"', '"delta":\ndata: {"type"')
    .replace(/\n/g, '\r\n')
  const result = analyzeSse(': keepalive\r\n\r\n' + raw, '你好')
  assert.equal(result.stream_complete, true)
  assert.equal(result.exact_text, true)
})

test('exact text cannot hide an error or a truncated stream', () => {
  const partial = [start, block(''), delta('PASS')]
  assert.equal(analyzeSse(wire(partial), 'PASS').stream_complete, false)
  const result = analyzeSse(
    wire([...partial, { type: 'error', error: { type: 'overloaded_error' } }, ...finish]),
    'PASS',
  )
  assert.equal(result.exact_text, true)
  assert.equal(result.stream_complete, false)
  assert.ok(result.failures.includes('upstream_error:overloaded_error'))
})

test('complete transport is separate from a semantic mismatch', () => {
  const result = analyzeSse(wire([start, block(''), delta('An explanation instead.'), ...finish]), 'PASS')
  assert.equal(result.stream_complete, true)
  assert.equal(result.exact_text, false)
  assert.equal(result.text, 'An explanation instead.')
})

test('duplicate streams and deltas without an open block fail', () => {
  const complete = wire([start, block(''), delta('PASS'), ...finish])
  assert.equal(analyzeSse(complete + complete, 'PASS').stream_complete, false)
  assert.equal(analyzeSse(wire([start, delta('PASS'), ...finish]), 'PASS').stream_complete, false)
})

test('malformed JSON is not silently classified as missing model text', () => {
  assert.throws(() => analyzeSse('data: {invalid}\n\n', 'PASS'), SyntaxError)
})

test('missing message metadata and oversized captures are rejected', () => {
  const result = analyzeSse(wire([{ type: 'message_start' }, block('PASS'), ...finish]), 'PASS')
  assert.equal(result.stream_complete, false)
  assert.ok(result.failures.includes('invalid_message_start'))
  assert.throws(() => analyzeSse('x'.repeat(2 * 1024 * 1024 + 1), 'PASS'), /exceeds acceptance limit/)
  assert.throws(() => analyzeSse(wire([start, { ...block('PASS'), index: 2 ** 31 }]), 'PASS'), /invalid block index/)
})

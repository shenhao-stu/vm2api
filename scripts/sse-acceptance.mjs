import crypto from 'node:crypto'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { applyClaudeSSELineToMessage, createClaudeMessageAssembler } from '../src/lib/protocol/convert.mjs'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/** Offline check of an operator-owned synthetic response; never sends or retries a request. */
export function analyzeSse(raw, expectedText) {
  if (typeof expectedText !== 'string' || !expectedText.trim()) throw new Error('expected text is required')
  if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new Error('response exceeds acceptance limit')
  const state = createClaudeMessageAssembler()
  const events = []
  const failures = []
  const openBlocks = new Set()
  const seenBlocks = new Set()
  const legacyParts = []
  let started = false
  let stopped = false
  for (const frame of raw.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data || data === '[DONE]') continue
    const event = JSON.parse(data)
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error('invalid SSE event')
    const kind = event.type
    events.push(kind)
    if (kind === 'ping') continue
    if (stopped) failures.push('event_after_message_stop')
    if (kind === 'message_start') {
      if (started) failures.push('duplicate_message_start')
      if (event.message?.role !== 'assistant' || !Array.isArray(event.message?.content))
        failures.push('invalid_message_start')
      started = true
    } else if (!started) failures.push('event_before_message_start')
    if (kind === 'content_block_start') {
      if (!Number.isInteger(event.index) || event.index < 0 || event.index > 1024)
        throw new Error('invalid block index')
      if (seenBlocks.has(event.index)) failures.push('invalid_block_start')
      seenBlocks.add(event.index)
      openBlocks.add(event.index)
    }
    if (kind === 'content_block_delta' && !openBlocks.has(event.index)) failures.push('delta_outside_block')
    if (kind === 'content_block_stop' && !openBlocks.delete(event.index)) failures.push('stop_outside_block')
    if (kind === 'content_block_delta' && event.delta?.type === 'text_delta') legacyParts.push(event.delta.text || '')
    if (kind === 'error') failures.push(`upstream_error:${event.error?.type || 'unknown'}`)
    if (kind === 'message_stop') stopped = true
    applyClaudeSSELineToMessage(`data: ${JSON.stringify(event)}`, state)
  }
  if (!started) failures.push('missing_message_start')
  if (!stopped) failures.push('missing_message_stop')
  if (openBlocks.size) failures.push('unclosed_content_block')
  const message = state.message || {}
  if (message.stop_reason !== 'end_turn') failures.push('unexpected_stop_reason')
  const text = (message.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text || '')
    .join('')
  return {
    stream_complete: failures.length === 0,
    exact_text: text.trim() === expectedText,
    legacy_exact_text: legacyParts.join('').trim() === expectedText,
    text,
    text_sha256: crypto.createHash('sha256').update(text).digest('hex'),
    text_bytes: Buffer.byteLength(text),
    event_types: events,
    block_types: (message.content || []).map((block) => block.type),
    stop_reason: message.stop_reason || null,
    usage: message.usage || {},
    failures,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , file, expectedText] = process.argv
  if (!file || !expectedText)
    throw new Error('Usage: node scripts/sse-acceptance.mjs OWN_SYNTHETIC_RESPONSE EXPECTED_TEXT')
  if (fs.statSync(file).size > MAX_RESPONSE_BYTES) throw new Error('response exceeds acceptance limit')
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file))
  const { text: _text, ...result } = analyzeSse(raw, expectedText)
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.stream_complete && result.exact_text ? 0 : 1
}

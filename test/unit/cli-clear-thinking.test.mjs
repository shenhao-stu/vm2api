import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'

const clearThinking = { type: 'clear_thinking_20251015', keep: 'all' }

function request(overrides = {}) {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    thinking: { type: 'disabled' },
    context_management: { edits: [clearThinking] },
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  }
}

test('CLI hop removes clear-thinking when explicit thinking is disabled', () => {
  const body = prepareCliHopBody(request())
  assert.equal(body.thinking.type, 'disabled')
  assert.equal(body.context_management, undefined)
})

test('repaired CLI hop removes incompatible clear-thinking without refilling thinking', () => {
  for (const [model, thinking] of [
    ['claude-sonnet-4-6', undefined],
    ['claude-haiku-4-5-20251001', { type: 'disabled' }],
  ]) {
    const body = prepareCliHopBody(request({ model, thinking }), { repaired: true })
    assert.equal(body.thinking?.type, thinking?.type)
    assert.equal(body.context_management, undefined)
  }
})

test('CLI hop cleanup preserves unrelated edits, context fields and caller objects', () => {
  const tool = { type: 'clear_tool_uses_20250919', keep: { type: 'tool_uses', value: 3 } }
  const unknown = { type: 'unknown_strategy_for_validation' }
  const input = request({ context_management: { edits: [clearThinking, tool, unknown], extra: 'validate' } })
  const before = structuredClone(input)
  const body = prepareCliHopBody(input, { preserveSystem: true })
  assert.deepEqual(body.context_management, { edits: [tool, unknown], extra: 'validate' })
  assert.deepEqual(input, before)
})

test('CLI hop preserves supported clear-thinking for enabled and adaptive models', () => {
  for (const model of ['claude-sonnet-4-6', 'claude-haiku-5-5', 'claude-fable-5-1']) {
    for (const thinking of [{ type: 'enabled', budget_tokens: 2048 }, { type: 'adaptive' }]) {
      const body = prepareCliHopBody(request({ model, thinking }))
      assert.deepEqual(body.context_management, { edits: [clearThinking] })
    }
  }
})

test('CLI hop leaves malformed and unknown context controls for existing validation', () => {
  for (const context_management of [
    { edits: 'invalid' },
    { edits: [null, { type: 'unknown_strategy' }] },
    { edits: [{ type: 'clear_tool_uses_20250919' }] },
    { edits: [clearThinking], extra: 'validate' },
  ]) {
    const body = prepareCliHopBody(request({ context_management }))
    const expected = context_management.extra ? { edits: [], extra: 'validate' } : context_management
    assert.deepEqual(body.context_management, expected)
  }
})

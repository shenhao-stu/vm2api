import assert from 'node:assert/strict'
import test from 'node:test'
import { validateRequestBody } from '../../src/lib/core/errors.mjs'
import { thinkingRequestError } from '../../src/lib/protocol/thinking-validation.mjs'

const base = { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'fixture' }], max_tokens: 4096 }
const valid = [
  { ...base, model: 'claude-sonnet-4-6', thinking: { type: 'enabled', budget_tokens: 8192 } },
  { ...base },
  { ...base, thinking: { type: 'adaptive' } },
  { ...base, thinking: { type: 'adaptive', display: 'omitted' } },
  ...['low', 'medium', 'high', undefined].map((effort) => ({
    ...base,
    thinking: { type: 'between_tools' },
    output_config: { effort },
  })),
  { ...base, model: 'anthropic/claude-sonnet-5.5[1m]', thinking: { type: 'between_tools' } },
  { ...base, model: 'claude-fable-5-2', thinking: { type: 'adaptive' } },
  { ...base, model: 'claude-opus-5-5', thinking: { type: 'adaptive' } },
  { ...base, model: 'claude-haiku-5-5', thinking: { type: 'disabled' }, output_config: { effort: 'high' } },
  { ...base, model: 'claude-sonnet-4-6', thinking: { type: 'enabled', budget_tokens: 1024 } },
  { ...base, model: 'claude-haiku-4-5', thinking: { type: 'disabled' } },
  { ...base, model: 'gpt-6.1-terra', thinking: { type: 'unrelated' } },
]
for (const [index, body] of valid.entries()) {
  test(`valid request ${index}: pure validation preserves caller history and intent`, () => {
    const before = structuredClone(body)
    assert.equal(thinkingRequestError(body), null)
    assert.equal(validateRequestBody('anthropic.messages', body).ok, true)
    assert.deepEqual(body, before)
  })
}
for (const body of [
  { ...base, thinking: null },
  { ...base, thinking: 'adaptive' },
  { ...base, thinking: { type: 'between_tools', display: 'omitted' } },
  { ...base, thinking: { type: 'between_tools', budget_tokens: 1024 } },
  { ...base, thinking: { type: 'between_tools', block_binding: true } },
  { ...base, model: 'anthropic/claude-fable-5.2[1m]', thinking: { type: 'disabled' } },
  { ...base, model: 'claude-opus-5-5-20261001', thinking: { type: 'enabled', budget_tokens: 1024 } },
  { ...base, model: 'claude-haiku-5-5', thinking: { type: 'disabled' }, output_config: { effort: 'max' } },
  { ...base, model: 'claude-haiku-5-5', thinking: { type: 'enabled', budget_tokens: 1024 } },
  { ...base, model: 'claude-sonnet-4-6', thinking: { type: 'enabled', budget_tokens: '1024' } },
]) {
  test(`invalid ${JSON.stringify({ model: body.model, thinking: body.thinking, effort: body.output_config?.effort })}`, () => {
    const before = structuredClone(body)
    const result = validateRequestBody('anthropic.messages', body)
    assert.equal(result.ok, false)
    assert.equal(result.errorResult.status, 400)
    assert.equal(result.errorResult.body.error.type, 'invalid_request_error')
    assert.equal(result.errorResult.body.error.code, 'invalid_field')
    assert.match(result.errorResult.body.error.param, /^(thinking|output_config)/)
    assert.deepEqual(body, before)
  })
}

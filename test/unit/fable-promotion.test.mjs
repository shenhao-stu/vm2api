import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FABLE_52_ID as model,
  FABLE_PROMOTION_START as start,
  FABLE_PROMOTION_END as end,
  fablePromotionActive,
} from '../../src/lib/protocol/fable-promotion.mjs'
import { hostedModelDenial, filterHostedModels } from '../../src/lib/protocol/hosted-model-policy.mjs'
import {
  getModelPolicy,
  getModelEntry,
  normalizePolicy,
  normalizeThinkingByPolicy,
  applyModelRequestRules,
  validateToolChoice,
  isModelEnabled,
  getPolicyCatalogIds,
} from '../../src/lib/protocol/model-policy.mjs'
import { slotAllowsModel, modelMatchesAllowlist } from '../../src/lib/pool/slot-model-gate.mjs'
import { inferClaudeTier } from '../../src/lib/pool/claude-tier.mjs'
import { protectsClaudePro } from '../../src/lib/protocol/refusal-session-isolation.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
const pro = { id: 'claude-pro', has_token: true, claude: { mode: 'oauth', has_access: true, account_tier: 'pro' } }

test('official window is inclusive at launch, exclusive at expiry, and fails closed for invalid time', () => {
  for (const [now, active] of [
    [start - 1, false],
    [start, true],
    [end - 1, true],
    [end, false],
    [end + 1, false],
    [NaN, false],
  ]) {
    assert.equal(fablePromotionActive(now), active)
    assert.equal(hostedModelDenial(null, model, now) === null, active)
    assert.equal(
      filterHostedModels({ data: [{ id: model }, { id: 'claude-sonnet-5-5' }, { id: 'claude-fable-5-1' }] }, now).data
        .length,
      active ? 2 : 1,
    )
    assert.equal(slotAllowsModel({ vm: pro, model, now }).ok, active)
  }
})

test('only 5.2 and resolved aliases are allowed; old versions and key boundaries stay closed', () => {
  const policy = getModelPolicy()
  policy.aliases['claude-promo-test'] = model
  try {
    for (const id of [model, 'claude-fable-5.2', 'anthropic/CLAUDE-FABLE-5-2[1m]', 'claude-promo-test']) {
      assert.equal(hostedModelDenial(null, id, start), null)
      assert.equal(hostedModelDenial(null, id, end).code, 'model_disabled')
    }
    for (const id of ['fable', 'claude-fable-5', 'claude-fable-5-1', model + '-fake', 'claude-fable-5-3'])
      assert.equal(hostedModelDenial(null, id, start).code, 'model_disabled')
    assert.equal(
      hostedModelDenial({ category: 'hybrid', group_type: 'openai' }, model, start).code,
      'key_group_mismatch',
    )
  } finally {
    delete policy.aliases['claude-promo-test']
  }
})

test('temporary eligibility retains allowlists, model denials and Pro refusal isolation', () => {
  assert.equal(modelMatchesAllowlist(model, ['claude-fable-5']), false)
  assert.equal(modelMatchesAllowlist(model, ['claude-fable-5-1']), false)
  assert.equal(modelMatchesAllowlist(model, ['claude-fable-5.2']), true)
  assert.equal(
    slotAllowsModel({ vm: { ...pro, policy: { allowed_models: ['claude-sonnet-5-5'] } }, model, now: start }).reason,
    'model_not_allowed',
  )
  const unified = { account_tier: 'max', usage_has_fable: true, model_denied_until: { [model]: end } }
  assert.equal(slotAllowsModel({ vm: pro, account: { unified }, model, now: start }).reason, 'model_not_supported')
  assert.equal(inferClaudeTier({ has_token: true, account_tier: 'pro' }, unified).key, 'pro')
  assert.equal(protectsClaudePro({ vm: pro, account: { unified } }), true)
})

test('5.2 capability seed preserves stored switches and normalizes adaptive thinking', (t) => {
  t.mock.method(Date, 'now', () => start)
  const entry = getModelEntry(model)
  assert.equal(entry.capabilities.context_window, 1_000_000)
  assert.equal(entry.params.max_tokens_cap, 128_000)
  assert.equal(normalizePolicy({ models: { [model]: { enabled: false } } }).models[model].enabled, false)
  const body = { model, thinking: { type: 'enabled', budget_tokens: 2048 } }
  normalizeThinkingByPolicy(body)
  assert.deepEqual(body.thinking, { type: 'adaptive' })
  const wire = applyModelRequestRules({ model, thinking: { type: 'disabled' }, temperature: 0.5, top_p: 0.8 })
  assert.deepEqual(wire, { model, thinking: { type: 'adaptive' } })
  assert.throws(
    () => validateToolChoice({ model, tools: [{ name: 'echo' }], tool_choice: { type: 'tool', name: 'echo' } }),
    { status: 400 },
  )
  assert.equal(isModelEnabled(model), true)
  assert.ok(getPolicyCatalogIds({ enabledOnly: true }).includes(model))
  t.mock.method(Date, 'now', () => end)
  assert.equal(isModelEnabled(model), false)
  assert.ok(!getPolicyCatalogIds({ enabledOnly: true }).includes(model))
})

for (const phase of ['queue', 'prepare']) {
  test(`expiry during ${phase} rejects before worker dispatch and releases reserved concurrency`, async (t) => {
    let now = end - 1,
      released = 0,
      calls = 0
    t.mock.method(Date, 'now', () => now)
    const scheduler = {
      selectAndReserve: async () => {
        if (phase === 'queue') now = end
        return { ok: true, vmId: pro.id, accountId: 'pro', release: () => released++ }
      },
    }
    const runner = new FailoverRunner({ scheduler })
    const result = await runner.run({
      requestId: 'expiry-' + phase,
      model,
      canonicalBody: { model, messages: [{ role: 'user', content: 'Hello' }] },
      applyAttempt: async (body) => {
        now = end
        return body
      },
      callAttempt: async () => {
        calls++
        throw new Error('expired dispatch')
      },
    })
    assert.equal(result.localDenial.status, 403)
    assert.equal(result.localDenial.body.error.code, 'model_disabled')
    assert.equal(calls, 0)
    assert.equal(released, 1)
  })
}

test('full native Fable window blocks even if status has not changed to rejected', () => {
  const account = { unified: { '7d_oi': { utilization: 1, status: 'allowed', reset: new Date(end).toISOString() } } }
  const limited = AccountQuota.prototype.fableWindowLimited
  assert.equal(limited.call({}, 'pro', start, account), true)
  account.unified['7d_oi'].utilization = 0.99
  assert.equal(limited.call({}, 'pro', start, account), false)
  account.unified['7d_oi'].utilization = 1
  assert.equal(limited.call({}, 'pro', end, account), false)
})

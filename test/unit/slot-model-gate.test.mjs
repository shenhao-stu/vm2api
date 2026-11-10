import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  modelMatchesAllowlist,
  parseAllowedModelsPatch,
  slotAllowsModel,
  normalizeAllowedModels,
} from '../../src/lib/pool/slot-model-gate.mjs'
import { persistAllowedModels, summarizeVm } from '../../src/lib/vm/vm-registry.mjs'

test('empty allowlist inherits all models', () => {
  assert.equal(normalizeAllowedModels(null), null)
  assert.equal(normalizeAllowedModels([]), null)
  assert.equal(modelMatchesAllowlist('claude-opus-5', null), true)
})

test('allowlist matches aliases and dated prefixes', () => {
  assert.equal(modelMatchesAllowlist('claude-fable-5-20260801', ['claude-fable-5']), true)
  assert.equal(modelMatchesAllowlist('claude-fable-5', ['fable']), true)
  assert.equal(modelMatchesAllowlist('claude-opus-5', ['claude-sonnet-5']), false)
})

test('fable requires max even if the allowlist includes it', () => {
  const pro = slotAllowsModel({
    vm: { claude: { account_tier: 'pro' }, policy: { allowed_models: ['claude-fable-5'] } },
    model: 'claude-fable-5',
  })
  assert.equal(pro.ok, false)
  assert.equal(pro.reason, 'fable_requires_max')
  const unknown = slotAllowsModel({
    vm: { claude: {}, policy: {} },
    model: 'claude-fable-5',
  })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.reason, 'fable_requires_max')
  const max = slotAllowsModel({
    vm: { claude: { account_tier: 'max' }, policy: {} },
    model: 'claude-fable-5',
  })
  assert.equal(max.ok, true)
})

test('explicit Pro tier and recent model denial override stale Max usage', () => {
  const vm = { claude: { account_tier: 'pro' }, policy: {} }
  const account = { unified: { account_tier: 'max', usage_has_fable: true } }
  assert.deepEqual(slotAllowsModel({ vm, account, model: 'claude-fable-5' }), {
    ok: false,
    reason: 'fable_requires_max',
  })

  const maxVm = { claude: { account_tier: 'max' }, policy: {} }
  const denied = {
    unified: {
      account_tier: 'max',
      model_denied_until: { 'claude-fable-5': Date.now() + 60_000 },
    },
  }
  assert.deepEqual(slotAllowsModel({ vm: maxVm, account: denied, model: 'claude-fable-5' }), {
    ok: false,
    reason: 'model_not_supported',
  })
  assert.deepEqual(slotAllowsModel({ vm: maxVm, account: denied, model: 'claude-sonnet-5' }), { ok: true })
})

test('legacy Fable 5.1 allowlists accept the corrected id without allowing Fable 5', () => {
  assert.equal(modelMatchesAllowlist('claude-fable-5-1', ['claude-fable-5.1']), true)
  assert.equal(modelMatchesAllowlist('claude-fable-5.1', ['claude-fable-5-1']), true)
  assert.equal(modelMatchesAllowlist('claude-fable-5-1-20260918', ['claude-fable-5.1']), true)
  assert.equal(modelMatchesAllowlist('claude-fable-5-1', ['claude-fable-5']), false)
  assert.equal(modelMatchesAllowlist('claude-fable-5', ['claude-fable-5-1']), false)
  assert.equal(modelMatchesAllowlist('claude-fable-5', ['claude-fable-5.1']), false)
  assert.deepEqual(parseAllowedModelsPatch(['claude-fable-5.1']), { ok: true, value: ['claude-fable-5-1'] })
  const vm = { claude: { account_tier: 'max' }, policy: { allowed_models: ['claude-fable-5.1'] } }
  assert.deepEqual(slotAllowsModel({ vm, model: 'claude-fable-5-1' }), { ok: true })
  assert.deepEqual(slotAllowsModel({ vm, model: 'claude-fable-5' }), { ok: false, reason: 'model_not_allowed' })
  assert.deepEqual(slotAllowsModel({ vm: { ...vm, claude: { account_tier: 'pro' } }, model: 'claude-fable-5-1' }), {
    ok: false,
    reason: 'fable_requires_max',
  })
})

test('Opus 5.5 does not match an Opus 5 allowlist', () => {
  assert.equal(modelMatchesAllowlist('claude-opus-5-5', ['claude-opus-5']), false)
  assert.equal(modelMatchesAllowlist('claude-opus-5', ['claude-opus-5-5']), false)
  assert.equal(modelMatchesAllowlist('claude-opus-5.5', ['claude-opus-5-5']), true)
  assert.deepEqual(parseAllowedModelsPatch(['claude-opus-5.5']), { ok: true, value: ['claude-opus-5-5'] })
})

test('parseAllowedModelsPatch rejects unknown ids', () => {
  const bad = parseAllowedModelsPatch(['not-a-claude-model'])
  assert.equal(bad.ok, false)
  const ok = parseAllowedModelsPatch(['claude-fable-5', 'fable'])
  assert.equal(ok.ok, true)
  assert.ok(ok.value.includes('claude-fable-5'))
})

test('parseAllowedModelsPatch accepts GPT ids for Codex VMs', () => {
  const gpt = parseAllowedModelsPatch(['gpt-5.4'], { platform: 'openai' })
  assert.equal(gpt.ok, true)
  assert.deepEqual(gpt.value, ['gpt-5.4'])
  const mixed = parseAllowedModelsPatch(['gpt-5.4'], {})
  assert.equal(mixed.ok, false)
})

test('persistAllowedModels writes and summarizeVm echoes the list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-allowed-models-'))
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'vm-01.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      id: 'vm-01',
      name: '01',
      policy: { maxConcurrency: 2 },
      claude: { account_tier: 'max' },
    }),
  )
  persistAllowedModels(root, 'vm-01', ['claude-fable-5'])
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(saved.policy.allowed_models, ['claude-fable-5'])
  assert.deepEqual(summarizeVm(saved).allowed_models, ['claude-fable-5'])
  persistAllowedModels(root, 'vm-01', null)
  const cleared = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(cleared.policy.allowed_models, undefined)
  assert.equal(summarizeVm(cleared).allowed_models, null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('Codex slot rejects Claude models even with an empty allowlist', () => {
  const gpt = slotAllowsModel({
    vm: { platform: 'openai', family: 'codex', policy: {} },
    model: 'gpt-5.4',
  })
  assert.equal(gpt.ok, true)
  const claude = slotAllowsModel({
    vm: { platform: 'openai', family: 'codex', policy: {} },
    model: 'claude-haiku-4-5',
  })
  assert.equal(claude.ok, false)
  assert.equal(claude.reason, 'codex_model_required')
})

test('Claude slot rejects GPT models', () => {
  const hit = slotAllowsModel({
    vm: { platform: 'anthropic', family: 'claude', claude: { account_tier: 'max' }, policy: {} },
    model: 'gpt-5.4',
  })
  assert.equal(hit.ok, false)
  assert.equal(hit.reason, 'claude_model_required')
})

test('Pro launch entitlement expires at the fixed boundary while Max remains eligible', () => {
  const pro = {
    claude: { account_tier: 'pro', subscription_type: 'pro' },
    policy: { allowed_models: ['claude-fable-5-2'] },
  }
  const start = Date.parse('2026-11-09T18:00:00Z')
  const end = Date.parse('2026-11-17T07:59:00Z')
  for (const now of [start, end - 1]) {
    assert.equal(slotAllowsModel({ vm: pro, model: 'claude-fable-5-2', now }).ok, true)
    assert.equal(slotAllowsModel({ vm: pro, model: 'claude-fable-5.2', now }).ok, true)
    assert.equal(slotAllowsModel({ vm: pro, model: 'claude-fable-5-1', now }).ok, false)
  }
  for (const now of [start - 1, end, end + 1, NaN]) {
    assert.equal(slotAllowsModel({ vm: pro, model: 'claude-fable-5-2', now }).ok, false)
  }
  for (const subscription_type of ['max', 'max5x', 'max20x', 'ultra']) {
    const vm = { claude: { subscription_type }, policy: {} }
    assert.equal(slotAllowsModel({ vm, model: 'claude-fable-5-2', now: end + 1 }).ok, true)
  }
  const defaultPlan = { claude: { account_tier: 'pro', account_tier_source: 'default' }, policy: {} }
  assert.equal(slotAllowsModel({ vm: defaultPlan, model: 'claude-fable-5-2', now: start }).ok, false)
  const polluted = { claude: { account_tier: 'max', account_tier_source: 'usage' }, policy: {} }
  assert.equal(slotAllowsModel({ vm: polluted, model: 'claude-fable-5-2', now: start }).ok, false)
  assert.equal(slotAllowsModel({ vm: { claude: {}, policy: {} }, model: 'claude-fable-5-2', now: start }).ok, false)
})

test('Fable versions do not broaden each other through prefix or dotted aliases', () => {
  const versions = ['claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2']
  for (const model of versions) {
    for (const allowed of versions) assert.equal(modelMatchesAllowlist(model, [allowed]), model === allowed)
  }
  assert.equal(modelMatchesAllowlist('claude-fable-5-2-20261109', ['claude-fable-5.2']), true)
  assert.equal(modelMatchesAllowlist('claude-fable-5-2-extra', ['claude-fable-5-2']), false)
})

test('temporary entitlement does not override operator model allowlist or upstream denial', () => {
  const now = Date.parse('2026-11-10T00:00:00Z')
  const vm = { claude: { subscription_type: 'pro' }, policy: { allowed_models: ['claude-opus-5-5'] } }
  assert.equal(slotAllowsModel({ vm, model: 'claude-fable-5-2', now }).reason, 'model_not_allowed')
  const account = { unified: { model_denied_until: { 'claude-fable-5-2': now + 1000 } } }
  assert.equal(
    slotAllowsModel({ vm: { ...vm, policy: {} }, account, model: 'claude-fable-5-2', now }).reason,
    'model_not_supported',
  )
})

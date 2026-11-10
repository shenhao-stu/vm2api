import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { inferClaudeTier } from '../../src/lib/pool/claude-tier.mjs'
import { inferTierFromOfficialStats } from '../../src/lib/oauth/official-cc-stats.mjs'
import { persistAccountTier } from '../../src/lib/vm/vm-registry.mjs'
import { protectsClaudePro } from '../../src/lib/protocol/refusal-session-isolation.mjs'

const usage = {
  ok: true,
  usage_status: 200,
  limits_present: true,
  usage_has_fable: true,
  seven_day_oi: { utilization: 0.3, resets_at: '2026-11-17T08:00:00Z' },
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-authority-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
test('promotional Fable usage cannot overwrite Pro or remove refusal isolation', (t) => {
  const q = new AccountQuota({ dataDir: fixture(t), config: {} })
  q.ensure({ account_id: 'pro' })
  q.setAccountTier('pro', 'pro', { source: 'profile' })
  q.ingestOAuthUsage('pro', usage)
  const account = q.repo.get('pro')
  assert.equal(account.unified.account_tier, 'pro')
  assert.equal(account.unified.account_tier_source, 'profile')
  assert.equal(account.unified.usage_has_fable, true)
  assert.equal(account.unified['7d_oi'].utilization, 0.3)
  assert.equal(protectsClaudePro({ vm: { id: 'pro', claude: { mode: 'oauth', has_access: true } }, account }), true)
})
test('model entitlement alone cannot classify a subscription', () => {
  for (const observation of [
    { usage_has_fable: true },
    { usage_has_fable: false },
    { seven_day_oi: { utilization: 0.3 } },
    { fable: { ok: true } },
  ])
    assert.equal(inferTierFromOfficialStats('', observation), null)
  assert.equal(inferClaudeTier({ has_token: true, usage_has_fable: true }).key, 'pro')
  assert.equal(inferClaudeTier({ has_token: true, account_tier: 'max', usage_has_fable: false }).key, 'max')
})
test('usage writes cannot replace profile-sourced subscription in either store', (t) => {
  const root = fixture(t)
  fs.mkdirSync(path.join(root, 'vms'))
  const file = path.join(root, 'vms', 'pro.json')
  fs.writeFileSync(file, JSON.stringify({ id: 'pro', claude: { account_tier: 'pro', account_tier_source: 'profile' } }))
  persistAccountTier(root, 'pro', 'max', { source: 'usage' })
  assert.equal(JSON.parse(fs.readFileSync(file)).claude.account_tier, 'pro')
  const q = new AccountQuota({ dataDir: root, config: {} })
  q.ensure({ account_id: 'pro' })
  q.setAccountTier('pro', 'pro', { source: 'profile' })
  q.setAccountTier('pro', 'max', { source: 'usage' })
  assert.equal(q.repo.get('pro').unified.account_tier, 'pro')
  q.setAccountTier('pro', 'max', { source: 'profile' })
  assert.equal(q.repo.get('pro').unified.account_tier, 'max')
})

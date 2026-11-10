import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { probeAccount } from '../../src/lib/oauth/usage-probe.mjs'
import { persistVmSubscription, persistAccountTier } from '../../src/lib/vm/vm-registry.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { isCompleteOAuthUsage } from '../../src/lib/oauth/crs-usage-probe.mjs'

const usage = {
  ok: true,
  usage_status: 200,
  limits_present: true,
  usage_has_fable: true,
  five_hour: { utilization: 0.2 },
  seven_day: { utilization: 0.8 },
  seven_day_oi: { utilization: 0.1 },
}
const vm = { id: 'vm-pro', claude: { account_uuid: 'a-pro', org_uuid: 'o-pro', account_tier: 'max' } }
const profile = {
  ok: true,
  body: {
    account: { uuid: 'a-pro', has_claude_pro: true },
    organization: { uuid: 'o-pro', organization_type: 'claude_pro', rate_limit_tier: 'default_claude_pro' },
  },
}

test('official profile corrects Pro during a temporary Fable entitlement without a model call', async () => {
  const operations = []
  const result = await probeAccount({
    vm,
    probeUsage: async () => usage,
    slotOauth: async (_exec, op) => {
      operations.push(op)
      return profile
    },
  })
  assert.deepEqual(operations, ['profile'])
  assert.equal(result.account_tier, 'pro')
  assert.equal(result.account_tier_source, 'profile')
  assert.equal(result.subscription_type, 'pro')
  assert.equal(result.seven_day.utilization, 0.8)
  assert.equal(result.seven_day_oi.utilization, 0.1)
})

test('normal usage refresh reuses known subscription; an explicit refresh rechecks it', async () => {
  let requests = 0
  const opts = {
    vm: { ...vm, claude: { ...vm.claude, subscription_type: 'pro' } },
    probeUsage: async () => usage,
    slotOauth: async () => {
      requests++
      return profile
    },
  }
  await probeAccount(opts)
  assert.equal(requests, 0)
  await probeAccount({ ...opts, refreshSubscription: true })
  assert.equal(requests, 1)
})

test('profile failure preserves known Max metadata and successful quota observations', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-subscription-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const q = new AccountQuota({ dataDir: dir, config: {} })
  q.ensure({ account_id: 'a-max' })
  q.setAccountTier('a-max', 'max', { source: 'profile' })
  for (const slotOauth of [
    async () => {
      throw new Error('offline')
    },
    async () => ({ ok: false, status: 502 }),
  ]) {
    const result = await probeAccount({ vm, probeUsage: async () => usage, slotOauth })
    assert.equal(result.ok, true)
    q.ingestOAuthUsage('a-max', result)
    assert.equal(q.repo.get('a-max').unified.account_tier, 'max')
    assert.equal(q.repo.get('a-max').unified.account_tier_source, 'profile')
  }
})

test('profile belongs to the same slot account and cannot cross an import boundary', async (t) => {
  const result = await probeAccount({
    vm,
    probeUsage: async () => usage,
    slotOauth: async () => ({
      ...profile,
      body: { ...profile.body, account: { ...profile.body.account, uuid: 'other' } },
    }),
  })
  assert.equal(result.subscription_error, 'profile_identity_mismatch')
  assert.equal(result.subscription_type, undefined)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-subscription-persist-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  const file = path.join(root, 'vms', `${vm.id}.json`)
  fs.writeFileSync(file, JSON.stringify(vm))
  assert.equal(persistVmSubscription(root, vm.id, profile.body, { accountUuid: 'other' }), null)
  const saved = persistVmSubscription(root, vm.id, profile.body, { accountUuid: 'a-pro', orgUuid: 'o-pro' })
  assert.equal(saved.claude.subscription_type, 'pro')
  assert.equal(persistAccountTier(root, vm.id, 'max', { source: 'profile', accountUuid: 'other' }), null)
  assert.equal(persistAccountTier(root, vm.id, 'max', { source: 'profile', orgUuid: 'other-org' }), null)
  persistAccountTier(root, vm.id, 'pro', { source: 'profile', accountUuid: 'a-pro', orgUuid: 'o-pro' })
  persistAccountTier(root, vm.id, 'max', { source: 'usage' })
  assert.equal(JSON.parse(fs.readFileSync(file)).claude.account_tier, 'pro')
})

test('Ultra usage may omit the five-hour window but never accepts a malformed one', () => {
  assert.equal(isCompleteOAuthUsage({ five_hour: null, seven_day: { utilization: 20 }, extra_usage: null }), true)
  assert.equal(isCompleteOAuthUsage({ seven_day: { utilization: 20 }, seven_day_oi: { utilization: 10 } }), true)
  assert.equal(isCompleteOAuthUsage({ five_hour: {}, seven_day: { utilization: 20 }, extra_usage: null }), false)
})

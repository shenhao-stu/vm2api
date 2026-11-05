import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'

function fixture(t, cap, { override = true, tier = 'default' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-concurrency-'))
  const accountId = 'test-account'
  const quota = new AccountQuota({
    dataDir: path.join(root, 'data'),
    accounts: [
      {
        account_id: accountId,
        vm_id: 'vm-02',
        max_concurrency: cap,
        concurrency_override: override,
      },
    ],
  })
  quota.setAccountTier(accountId, tier)
  const vmPath = path.join(root, 'vms/vm-02.json')
  fs.mkdirSync(path.dirname(vmPath), { recursive: true })
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-02',
      claude: { account_uuid: accountId, account_tier: tier },
      policy: { maxConcurrency: cap, concurrencyOverride: override },
    }),
  )
  const runtime = createRoutingRuntime({
    cfg: { paths: { project: root } },
    accountQuota: quota,
    routingConfig: { tiers: {}, quota: {}, concurrency: {} },
  })
  t.after(() => {
    quota.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    runtime,
    vmPath,
    policy: () => JSON.parse(fs.readFileSync(vmPath, 'utf8')).policy,
    account: () => quota.repo.get(accountId),
  }
}

for (const cap of [0, 2, 16, 20]) {
  test(`tier synchronization preserves a manual concurrency value of ${cap}`, (t) => {
    const f = fixture(t, cap)
    const applied = f.runtime.applyRoutingTierConcurrency({ default: { max_concurrency: 4 } })
    assert.equal(applied.skipped, 1)
    assert.equal(f.policy().maxConcurrency, cap)
    assert.equal(f.policy().concurrencyOverride, true)
    assert.equal(f.account().max_concurrency, cap)
    assert.equal(Boolean(f.account().concurrency_override), true)
  })

  test(`global default updates preserve a manual concurrency value of ${cap}`, (t) => {
    const f = fixture(t, cap)
    f.runtime.applyRoutingConcurrency(4)
    assert.equal(f.policy().maxConcurrency, cap)
    assert.equal(f.policy().concurrencyOverride, true)
    assert.equal(f.account().max_concurrency, cap)
    assert.equal(Boolean(f.account().concurrency_override), true)
  })
}

for (const tier of ['default', 'pro', 'max']) {
  test(`inherited ${tier} concurrency receives the tier default`, (t) => {
    const f = fixture(t, 2, { override: false, tier })
    const applied = f.runtime.applyRoutingTierConcurrency({ [tier]: { max_concurrency: 6 } })
    assert.equal(applied[tier], 1)
    assert.equal(f.policy().maxConcurrency, 6)
    assert.equal(f.policy().concurrencyOverride, false)
    assert.equal(f.account().max_concurrency, 6)
  })
}

test('global default updates still reach inherited concurrency', (t) => {
  const f = fixture(t, 2, { override: false })
  f.runtime.applyRoutingConcurrency(4)
  assert.equal(f.policy().maxConcurrency, 4)
  assert.equal(f.policy().concurrencyOverride, false)
  assert.equal(f.account().max_concurrency, 4)
})

test('tier synchronization does not rewrite an unchanged inherited VM record', (t) => {
  const f = fixture(t, 4, { override: false })
  const before = fs.readFileSync(f.vmPath, 'utf8')
  const applied = f.runtime.applyRoutingTierConcurrency({ default: { max_concurrency: 4 } })
  assert.equal(applied.default, 0)
  assert.equal(fs.readFileSync(f.vmPath, 'utf8'), before)
})

function rpmFixture(t, rpm, { override = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-rpm-'))
  const accountId = 'test-account'
  const quota = new AccountQuota({
    dataDir: path.join(root, 'data'),
    accounts: [{ account_id: accountId, vm_id: 'vm-02', max_rpm: rpm }],
  })
  const vmPath = path.join(root, 'vms/vm-02.json')
  fs.mkdirSync(path.dirname(vmPath), { recursive: true })
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-02',
      claude: { account_uuid: accountId, account_tier: 'default' },
      policy: { maxRpm: rpm, rpmOverride: override },
    }),
  )
  const runtime = createRoutingRuntime({
    cfg: { paths: { project: root } },
    accountQuota: quota,
    routingConfig: { tiers: {}, quota: {}, concurrency: {} },
  })
  t.after(() => {
    quota.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    runtime,
    vmPath,
    policy: () => JSON.parse(fs.readFileSync(vmPath, 'utf8')).policy,
    account: () => quota.repo.get(accountId),
  }
}

test('tier RPM synchronization preserves a manual RPM value', (t) => {
  const f = rpmFixture(t, 30)
  const applied = f.runtime.applyRoutingTierRpm({ default: { max_rpm: 10 } })
  assert.equal(applied.skipped, 1)
  assert.equal(f.policy().maxRpm, 30)
  assert.equal(f.policy().rpmOverride, true)
  assert.equal(f.account().max_rpm, 30)
})

test('tier RPM synchronization updates inherited RPM and skips unchanged records', (t) => {
  const f = rpmFixture(t, 10, { override: false })
  const before = fs.readFileSync(f.vmPath, 'utf8')
  assert.equal(f.runtime.applyRoutingTierRpm({ default: { max_rpm: 10 } }).default, 0)
  assert.equal(fs.readFileSync(f.vmPath, 'utf8'), before)
  assert.equal(f.runtime.applyRoutingTierRpm({ default: { max_rpm: 20 } }).default, 1)
  assert.equal(f.policy().maxRpm, 20)
  assert.equal(f.account().max_rpm, 20)
})

for (const keyCap of [0, 64]) {
  test(`tier defaults keep independent key concurrency ${keyCap}`, () => {
    const routingConfig = {
      concurrency: { default_key_concurrency: keyCap },
      tiers: { default: { max_concurrency: 1 } },
    }
    createRoutingRuntime({ routingConfig }).syncTierDefaultsIntoRouting()
    assert.equal(routingConfig.concurrency.default_key_concurrency, keyCap)
    assert.equal(routingConfig.concurrency.default_max_per_account, 1)
  })
}

test('legacy routing without a key default retains the tier fallback', () => {
  const routingConfig = { tiers: { default: { max_concurrency: 3 } } }
  createRoutingRuntime({ routingConfig }).syncTierDefaultsIntoRouting()
  assert.equal(routingConfig.concurrency.default_key_concurrency, 3)
})

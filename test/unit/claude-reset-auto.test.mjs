import test from 'node:test'
import assert from 'node:assert/strict'
import {
  autoResetReason,
  autoResetEligible,
  createClaudeResetAuto,
  RESET_EXPIRY_LEAD_MS,
} from '../../src/lib/oauth/claude-reset-auto.mjs'
const NOW = Date.parse('2026-11-10T03:00:00Z')
const END = Date.parse('2026-11-17T07:59:00Z')
const grant = {
  resets_left: 1,
  clears: ['five_hour', 'seven_day_overage_included'],
  expires_at: new Date(END).toISOString(),
  percent_used: { five_hour: 100, seven_day: 100, seven_day_overage_included: 20 },
  redeemable: true,
}
const vm = {
  id: 'pro',
  status: 'running',
  schedulable: true,
  claude: { mode: 'oauth', has_access: true, account_tier: 'pro', account_uuid: 'a' },
}
const account = { account_id: 'a', unified: {} }

test('only Fable weekly exhaustion or the final fifteen minutes trigger a reset', () => {
  assert.equal(autoResetReason(grant, NOW), null)
  assert.equal(autoResetReason({ ...grant, percent_used: { seven_day_overage_included: 100 } }, NOW), 'fable_exhausted')
  assert.equal(autoResetReason(grant, END - RESET_EXPIRY_LEAD_MS - 1), null)
  assert.equal(autoResetReason(grant, END - RESET_EXPIRY_LEAD_MS), 'expiring')
  assert.equal(autoResetReason(grant, END), null)
  assert.equal(autoResetReason({ ...grant, expires_at: 'bad' }, NOW), null)
  assert.equal(autoResetReason({ ...grant, resets_left: 0 }, END - 1), null)
  assert.equal(autoResetReason({ ...grant, clears: ['five_hour'] }, END - 1), null)
})

test('manual holds, revoked credentials, native relays and Max are excluded; quota holds may recover', () => {
  assert.equal(autoResetEligible(vm, account), true)
  for (const change of [
    { schedule_manual: true },
    { schedulable: false },
    { status: 'stopped' },
    { schedule_disabled_reason: 'oauth_revoked' },
    { schedule_disabled_reason: 'exit_guard_policy_change' },
    { id: 'reclaude-native' },
    { claude: { ...vm.claude, account_tier: 'max' } },
  ])
    assert.equal(autoResetEligible({ ...vm, ...change }, account), false)
  assert.equal(
    autoResetEligible({ ...vm, schedulable: false, schedule_disabled_reason: 'quota_7d_header' }, account),
    true,
  )
})

function fixture(overrides = {}) {
  let releases = 0,
    reserved = 0,
    queries = 0,
    posts = 0,
    refreshed = 0,
    enabled = true
  const credits = { credits: [{ ...grant, percent_used: { seven_day_overage_included: 100 } }] }
  const monitor = createClaudeResetAuto({
    projectRoot: '/unused',
    getConfig: () => ({ enabled }),
    listTargets: () => [vm],
    accountForVm: () => account,
    readVm: () => vm,
    now: () => NOW,
    reserve: () => {
      reserved++
      return () => releases++
    },
    query: async () => {
      queries++
      return { ok: true, claude_reset_credits: credits }
    },
    redeem: async (opts) => {
      posts++
      assert.equal(opts.shouldRedeem({}, { ...credits.credits[0], ends_at: grant.expires_at }, NOW), true)
      return { ok: true, outcome: 'reset' }
    },
    afterReset: async () => {
      refreshed++
    },
    ...overrides,
  })
  return {
    monitor,
    counts: () => ({ releases, reserved, queries, posts, refreshed }),
    disable: () => {
      enabled = false
    },
  }
}

test('concurrent ticks share one operation, release the inference permit and never redeem again', async (t) => {
  const f = fixture()
  t.after(() => f.monitor.stop())
  await Promise.all([f.monitor.start(), f.monitor.runOnce(), f.monitor.runOnce()])
  await f.monitor.runOnce()
  assert.deepEqual(f.counts(), { releases: 1, reserved: 1, queries: 1, posts: 1, refreshed: 1 })
})

test('busy slots do not issue metadata calls and failed calls release the permit', async (t) => {
  const busy = fixture({ reserve: () => null })
  t.after(() => busy.monitor.stop())
  await busy.monitor.start()
  assert.equal(busy.counts().queries, 0)
  const failed = fixture({
    query: async () => {
      throw new Error('timeout')
    },
  })
  t.after(() => failed.monitor.stop())
  await failed.monitor.start()
  assert.equal(failed.counts().releases, 1)
})

test('a disabled setting prevents new claims even if it changes while querying', async (t) => {
  let checked = false
  const f = fixture({
    redeem: async (opts) => {
      f.disable()
      checked = opts.shouldRedeem({}, { ...grant, percent_used: { seven_day_overage_included: 100 } }, NOW)
      return { ok: false, error: 'CLAUDE_RESET_CONDITION_CHANGED' }
    },
  })
  t.after(() => f.monitor.stop())
  await f.monitor.start()
  assert.equal(checked, false)
  assert.equal(f.counts().releases, 1)
})

test('an all-window reset never enters the Fable-only automation', () => {
  const fullReset = {
    ...grant,
    clears: [...grant.clears, 'seven_day'],
    percent_used: { seven_day_overage_included: 100 },
  }
  assert.equal(autoResetReason({ ...fullReset, expires_at: '2026-12-10T22:00:00Z' }, NOW), null)
  assert.equal(autoResetReason(fullReset, NOW), null)
  assert.equal(autoResetReason(fullReset, END - 1), null)
})

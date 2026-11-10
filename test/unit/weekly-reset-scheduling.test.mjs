import test from 'node:test'
import assert from 'node:assert/strict'
import {
  proWeeklyResetAt,
  weeklyResetRank,
  weeklyResetProbeDue,
  weeklyResetProbeTarget,
} from '../../src/lib/pool/weekly-reset-scheduling.mjs'
import { rankSeatCandidates } from '../../src/lib/pool/seat-planner.mjs'
import { createUsageProbeMonitor } from '../../src/lib/oauth/usage-probe-monitor.mjs'

const now = Date.parse('2026-11-10T14:00:00Z')
const day = 86400_000
const vm = {
  id: 'pro',
  status: 'running',
  schedulable: true,
  has_token: true,
  has_refresh: true,
  account_tier: 'pro',
  proxy: { url: 'socks5h://127.0.0.1:10000' },
}
const account = (reset) => ({
  account_id: 'a',
  status: 'active',
  unified: {
    account_tier: 'pro',
    headers: { '7d': { reset, utilization: 0.2 } },
  },
})

test('weekly ranking uses the displayed 7d reset, never the Fable window or a forecast', () => {
  const acc = account(now + day)
  acc.unified['7d_oi'] = { reset: now + 1 }
  assert.equal(proWeeklyResetAt(vm, acc), now + day)
  for (const other of [
    { ...vm, account_tier: 'max' },
    { ...vm, id: 'reclaude-native' },
    { ...vm, kind: 'codex', account_tier: 'codex' },
  ]) {
    assert.equal(proWeeklyResetAt(other, { ...acc, unified: {} }), null)
  }
  for (const value of [null, 'invalid', now, now - 1]) assert.equal(weeklyResetRank(value, now), Infinity)
  for (const value of [now + 1000, String((now + 1000) / 1000), new Date(now + 1000).toISOString()])
    assert.equal(weeklyResetRank(value, now), now + 1000)
})

test('seconds break same-day ties and a reset immediately moves a slot behind future windows', () => {
  const candidates = [
    { vmId: 'later', weeklyResetAt: now + 20_000, priority: 10, seatCap: 10 },
    { vmId: 'soon', weeklyResetAt: now + 10_000, priority: 1, seatCap: 10 },
    { vmId: 'unknown', weeklyResetAt: null, priority: 10, seatCap: 10 },
  ]
  const order = (at, strategy = 'weekly-reset') =>
    rankSeatCandidates(candidates, { strategy, now: at, openOf: () => 0 }).map((c) => c.vmId)
  assert.deepEqual(order(now), ['soon', 'later', 'unknown'])
  assert.equal(order(now + 10_000)[0], 'later')
  candidates[1].weeklyResetAt = now + 7 * day
  assert.equal(order(now + 10_000)[0], 'later')
  assert.equal(order(now, 'balanced')[0], 'later', 'disabling the strategy preserves manual priority')
})

test('weekly reconciliation skips live windows and backs off empty readings without inventing usage', () => {
  assert.equal(weeklyResetProbeDue(account(now + 1), now).due, false)
  const elapsed = account(now)
  assert.equal(weeklyResetProbeDue(elapsed, now).reason, 'weekly_reset_elapsed')
  elapsed.last_probe = { at: new Date(now).toISOString() }
  assert.equal(weeklyResetProbeDue(elapsed, now + 60_000).due, false)
  assert.equal(weeklyResetProbeDue(elapsed, now + 15 * 60_000).due, true)
  assert.equal(weeklyResetProbeDue(account(null), now).reason, 'weekly_reset_unknown')
  assert.equal(
    weeklyResetProbeTarget({ ...vm, schedulable: false, schedule_disabled_reason: 'quota_7d_safety' }, elapsed),
    true,
  )
  for (const change of [
    { status: 'stopped' },
    { schedule_manual: true },
    { schedulable: false },
    { schedule_disabled_reason: 'account_ban_operator_confirmed' },
    { id: 'reclaude-pro' },
  ])
    assert.equal(weeklyResetProbeTarget({ ...vm, ...change }, elapsed), false)
})

test('weekly monitor queries usage only, once per expired window, under the shared account permit', async () => {
  const acc = account(now - 1)
  let held = false
  let calls = 0
  const monitor = createUsageProbeMonitor({
    config: { mode: 'weekly-reset', concurrency: 1 },
    now: () => now,
    listTargets: () => [vm, { ...vm, id: 'manual', schedule_manual: true }, { ...vm, id: 'reclaude-pro' }],
    accountForVm: () => acc,
    reserve: () => {
      assert.equal(held, false)
      held = true
      return () => {
        held = false
      }
    },
    probeOne: async (_vm, options) => {
      assert.equal(held, true)
      assert.equal(options.usageOnly, true)
      calls++
      acc.unified.headers['7d'].reset = now + 7 * day
      return { ok: true, source: 'vm-oauth-usage' }
    },
  })
  assert.equal((await monitor.runOnce()).due, 1)
  assert.equal((await monitor.runOnce()).due, 0)
  assert.equal(calls, 1)
  assert.equal(held, false)
})

test('busy accounts are skipped; failed checks release the permit and back off', async () => {
  let busy = true
  let calls = 0
  let released = 0
  const monitor = createUsageProbeMonitor({
    config: { mode: 'weekly-reset' },
    now: () => now,
    listTargets: () => [vm],
    accountForVm: () => account(now - 1),
    reserve: () =>
      busy
        ? null
        : () => {
            released++
          },
    probeOne: async () => {
      calls++
      throw new Error('offline')
    },
  })
  assert.equal((await monitor.runOnce()).items[0].reason, 'account_busy')
  assert.equal(calls, 0)
  busy = false
  assert.equal((await monitor.runOnce()).items[0].ok, false)
  assert.equal(released, 1)
  assert.equal((await monitor.runOnce()).items[0].reason, 'probe_backoff')
  assert.equal(calls, 1)
})

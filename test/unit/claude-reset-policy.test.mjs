import assert from 'node:assert/strict'
import test from 'node:test'
import {
  claudeAutoResetKey,
  claudeResetCreditFingerprint,
  planClaudeFableReset,
} from '../../src/lib/oauth/claude-reset-policy.mjs'

const NOW = Date.parse('2026-11-10T04:00:00Z')
const DAY = 86400000
const iso = (ms) => new Date(ms).toISOString()

function fixture({ credit = {}, ...input } = {}) {
  return {
    vmId: 'vm-pro-01',
    enabled: true,
    accountReady: true,
    exitReady: true,
    now: NOW,
    credits: {
      eligible: true,
      fetched_at: iso(NOW),
      credits: [
        {
          redeemable: true,
          resets_left: 2,
          clears: ['five_hour', 'seven_day_overage_included'],
          percent_used: { seven_day_overage_included: 100 },
          expires_at: iso(NOW + 3 * DAY),
          use_requires_limit: false,
          ...credit,
        },
      ],
    },
    ...input,
  }
}

test('only an explicitly enabled, ready account with a verified exit can reset', () => {
  for (const patch of [{ enabled: false }, { accountReady: false }, { exitReady: false }, { vmId: '' }]) {
    assert.equal(planClaudeFableReset(fixture(patch)).action, 'skip')
  }
  assert.equal(planClaudeFableReset().action, 'skip')
})

test('exhausted Fable uses a fresh eligible card without tier inference', () => {
  const args = fixture()
  const original = structuredClone(args)
  const out = planClaudeFableReset(args)
  assert.equal(out.action, 'redeem')
  assert.equal(out.reason, 'fable_limit_reached')
  assert.deepEqual(args, original)
  assert.equal(out.idempotency_key.length, 75)
})

test('ordinary 5h or 7d exhaustion does not spend a non-expiring Fable card', () => {
  for (const percent_used of [
    { five_hour: 100, seven_day: 9, seven_day_overage_included: 13 },
    { five_hour: 100, seven_day_overage_included: 0 },
    { seven_day: 100, seven_day_overage_included: 99 },
  ]) {
    const plan = planClaudeFableReset(fixture({ credit: { percent_used } }))
    assert.deepEqual(plan, { action: 'skip', reason: 'no_reset_needed' })
  }
})

test('a stale or future snapshot requests only a fresh status query', () => {
  for (const time of [NOW - 600001, NOW + 5001, NaN]) {
    const args = fixture()
    args.credits.fetched_at = Number.isFinite(time) ? iso(time) : 'invalid'
    assert.equal(planClaudeFableReset(args).action, 'query')
  }
})

test('at limit never overrides official eligibility, cooldown or next-grant selection', () => {
  const args = fixture()
  args.credits.eligible = false
  assert.equal(planClaudeFableReset(args).reason, 'ineligible')
  args.credits.eligible = true
  args.credits.cooldown_until = iso(NOW + 1)
  assert.equal(planClaudeFableReset(args).reason, 'cooldown')
  args.credits.cooldown_until = 'bad'
  assert.equal(planClaudeFableReset(args).reason, 'cooldown')
  delete args.credits.cooldown_until
  args.credits.credits[0].redeemable = false
  assert.equal(planClaudeFableReset(args).reason, 'no_unique_next_credit')
})

test('unknown-purpose, expired, not-started and exhausted cards are never redeemed', () => {
  for (const credit of [
    { clears: ['five_hour', 'seven_day'] },
    { expires_at: iso(NOW) },
    { expires_at: null },
    { expires_at: 'bad' },
    { starts_at: iso(NOW + 1) },
    { starts_at: 'bad' },
    { resets_left: 0 },
    { resets_left: 1.5 },
    { blocking: ['seven_day'] },
  ])
    assert.equal(planClaudeFableReset(fixture({ credit })).action, 'skip')
})

test('expiring card needs a real benefit; zero usage does not waste it', () => {
  const credit = { expires_at: iso(NOW + DAY), percent_used: { seven_day_overage_included: 1 } }
  assert.equal(planClaudeFableReset(fixture({ credit })).reason, 'used_credit_expiring')
  credit.expires_at = iso(NOW + DAY + 1)
  assert.equal(planClaudeFableReset(fixture({ credit })).action, 'skip')
  credit.expires_at = iso(NOW + 1)
  for (const used of [0, -1, 101, NaN, '10']) {
    credit.percent_used = { seven_day_overage_included: used }
    assert.equal(planClaudeFableReset(fixture({ credit })).action, 'skip')
  }
})

test('a Fable card nearing expiry can refill another explicitly cleared, used window', () => {
  const credit = { expires_at: iso(NOW + 1), percent_used: { five_hour: 50 } }
  assert.equal(planClaudeFableReset(fixture({ credit })).reason, 'used_credit_expiring')
  credit.percent_used = { unrecognized_window: 50 }
  assert.equal(planClaudeFableReset(fixture({ credit })).action, 'skip')
})

test('a known Fable-limit response may trigger a card; it still cannot bypass eligibility', () => {
  const args = fixture({ credit: { percent_used: {} }, fableWindow: { exhausted: true, fetched_at: iso(NOW) } })
  assert.equal(planClaudeFableReset(args).action, 'redeem')
  args.credits.credits[0].redeemable = false
  assert.equal(planClaudeFableReset(args).action, 'skip')
})

test('old or already reset Fable-limit evidence cannot spend a card', () => {
  for (const fableWindow of [
    { exhausted: true },
    { exhausted: true, fetched_at: iso(NOW - 600001) },
    { exhausted: true, fetched_at: iso(NOW), resets_at: iso(NOW) },
    { exhausted: true, fetched_at: iso(NOW), resets_at: 'bad' },
  ])
    assert.equal(planClaudeFableReset(fixture({ credit: { percent_used: {} }, fableWindow })).action, 'skip')
})

test('idempotency is stable across usage, labels, window order and query timestamps', () => {
  const credit = fixture().credits.credits[0]
  const key = claudeAutoResetKey('vm-01', credit)
  const changed = {
    ...credit,
    percent_used: { five_hour: 12 },
    label: '翻译后标签',
    clears: [...credit.clears].reverse(),
  }
  assert.equal(claudeAutoResetKey('vm-01', changed), key)
  assert.notEqual(claudeAutoResetKey('vm-02', changed), key)
  assert.notEqual(claudeAutoResetKey('vm-01', { ...changed, resets_left: 1 }), key)
})

test('automatic reset keys isolate replacement accounts even when the launch grant is identical', () => {
  const args = fixture()
  args.credits.account_fingerprint = 'a'.repeat(64)
  const first = planClaudeFableReset(args)
  assert.equal(first.idempotency_key, claudeAutoResetKey(args.vmId, args.credits.credits[0], 'a'.repeat(64)))
  args.credits.account_fingerprint = 'b'.repeat(64)
  const replacement = planClaudeFableReset(args)
  assert.notEqual(replacement.idempotency_key, first.idempotency_key)
  assert.equal(replacement.fingerprint, first.fingerprint)
})

test('pending, unknown, malformed and non-success outcomes stay blocked past 24 hours', () => {
  for (const outcome of ['pending', 'unknown', 'cooldown', 'not_limited', 'ineligible', '', null, 'reset']) {
    const operations = [{ outcome, at: iso(NOW - 3 * DAY) }]
    assert.equal(planClaudeFableReset(fixture({ operations })).reason, 'operation_needs_reconciliation')
  }
  assert.equal(planClaudeFableReset(fixture({ operations: null })).action, 'blocked')
})

test('confirmed redemption requires fewer official remaining uses before a new claim', () => {
  const args = fixture()
  const first = planClaudeFableReset(args)
  args.operations = [{ ...first, outcome: 'reset' }]
  assert.equal(planClaudeFableReset(args).reason, 'await_confirmed_credit_decrement')
  args.credits.credits[0].resets_left = 3
  assert.equal(planClaudeFableReset(args).reason, 'await_confirmed_credit_decrement')
  args.credits.credits[0].resets_left = 1
  const second = planClaudeFableReset(args)
  assert.equal(second.action, 'redeem')
  assert.notEqual(second.idempotency_key, first.idempotency_key)
})

test('two indistinguishable eligible next grants require reconciliation, not guessing', () => {
  const args = fixture()
  args.credits.credits.push(structuredClone(args.credits.credits[0]))
  assert.equal(planClaudeFableReset(args).reason, 'no_unique_next_credit')
})

test('a different grant expiry cannot clear an older unresolved operation', () => {
  const args = fixture({ operations: [{ outcome: 'unknown', fingerprint: 'older' }] })
  args.credits.credits[0].expires_at = iso(NOW + 40 * DAY)
  assert.equal(planClaudeFableReset(args).action, 'blocked')
})

test('clock and policy boundaries reject invalid values', () => {
  for (const input of [{ now: NaN }, { expiryLeadMs: -1 }, { maxSnapshotAgeMs: 0 }]) {
    assert.equal(planClaudeFableReset(fixture(input)).action, 'blocked')
  }
})

test('public fingerprint and result contain no grant identifier, org or usage contents', () => {
  const args = fixture({ credit: { grant_id: 'private-grant', organization_uuid: 'private-org' } })
  const result = planClaudeFableReset(args)
  assert.equal(claudeResetCreditFingerprint(args.credits.credits[0]).length, 64)
  assert.equal(JSON.stringify(result).includes('private-'), false)
})

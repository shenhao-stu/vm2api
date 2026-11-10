import assert from 'node:assert/strict'
import test from 'node:test'
import { readyForReset, maintainFableResets } from '../../integrations/claude-fable-maintenance/maintenance.mjs'
const FP = 'a'.repeat(64)
const STATE_KEY = `pro1:${FP}`
const NOW = Date.parse('2026-11-10T04:00:00Z')
const vm = {
  id: 'pro1',
  status: 'running',
  schedulable: true,
  can_claude_reset: true,
  has_token: true,
  subscription_type: 'pro',
  proxy_id: 'px1',
}
const guard = {
  id: 'px1',
  required: true,
  revision: 'r1',
  expected_ip: '192.0.2.1',
  state: {
    ready: true,
    latched: false,
    revision: 'r1',
    expected_ip: '192.0.2.1',
    observed_ip: '192.0.2.1',
    checked_at: new Date(NOW).toISOString(),
  },
}
const credit = {
  redeemable: true,
  resets_left: 1,
  clears: ['five_hour', 'seven_day_overage_included'],
  percent_used: { seven_day_overage_included: 100 },
  expires_at: '2026-11-17T07:59:00Z',
  use_requires_limit: false,
}
function fixture({ fail = false, mutate = false } = {}) {
  const state = {},
    calls = [],
    snapshots = []
  const api = async (method, route, body, headers) => {
    calls.push({ method, route, body, headers })
    if (route === '/vms') return { items: [structuredClone(vm)] }
    if (route === '/proxy-exit-guard') return { proxies: [structuredClone(guard)] }
    if (route === '/vms/pro1') return { vm: { ...vm, schedulable: !mutate } }
    if (route.endsWith('/query'))
      return {
        claude_reset_credits: {
          eligible: true,
          account_fingerprint: FP,
          fetched_at: new Date(NOW).toISOString(),
          credits: [credit],
        },
      }
    if (route.endsWith('/redeem')) {
      assert.equal(snapshots.at(-1)[STATE_KEY][0].outcome, 'pending')
      if (fail) throw Error('lost')
      return { outcome: 'reset' }
    }
    throw Error('unexpected_route')
  }
  return {
    state,
    api,
    calls,
    snapshots,
    save: async (s) => snapshots.push(structuredClone(s)),
    enabled: true,
    now: () => NOW,
  }
}
test('manual stop, changed or stale exit, no OAuth and unknown plan never reset', () => {
  assert.equal(readyForReset(vm, guard, NOW), true)
  for (const change of [
    { schedulable: false },
    { can_claude_reset: false },
    { subscription_type: 'unknown' },
    { status: 'stopped' },
  ])
    assert.equal(readyForReset({ ...vm, ...change }, guard, NOW), false)
  for (const change of [
    { latched: true },
    { observed_ip: '192.0.2.2' },
    { revision: 'old' },
    { checked_at: new Date(NOW - 61000).toISOString() },
  ])
    assert.equal(readyForReset(vm, { ...guard, state: { ...guard.state, ...change } }, NOW), false)
})
test('reset saves intent before sending and repeated pass cannot spend same card', async () => {
  const f = fixture()
  const r = await maintainFableResets(f)
  assert.equal(r[0].outcome, 'reset')
  assert.equal(f.state[STATE_KEY][0].outcome, 'reset')
  await maintainFableResets(f)
  assert.equal(f.calls.filter((x) => x.route.endsWith('/redeem')).length, 1)
})
test('unknown network result permanently blocks automatic redemption', async () => {
  const f = fixture({ fail: true })
  await maintainFableResets(f)
  const before = f.calls.length
  const r = await maintainFableResets(f)
  assert.equal(r[0].action, 'blocked')
  assert.equal(
    f.calls.slice(before).some((x) => x.route.endsWith('/redeem')),
    false,
  )
})
test('operator stopping during query prevents redemption', async () => {
  const f = fixture({ mutate: true })
  const r = await maintainFableResets(f)
  assert.equal(r[0].reason, 'state_changed')
  assert.equal(f.snapshots.length, 0)
})
test('disabled automation does not query official endpoint or redeem', async () => {
  const f = fixture()
  await maintainFableResets({ ...f, enabled: false })
  assert.equal(f.calls.filter((x) => x.method === 'POST').length, 0)
})

test('5h exhaustion with Fable remaining performs only a metadata query', async () => {
  const f = fixture()
  const api = f.api
  f.api = async (...args) => {
    const result = await api(...args)
    if (!args[1].endsWith('/query')) return result
    const copy = structuredClone(result)
    copy.claude_reset_credits.credits[0].percent_used = {
      five_hour: 100,
      seven_day: 9,
      seven_day_overage_included: 13,
    }
    return copy
  }
  assert.deepEqual(await maintainFableResets(f), [{ vm_id: 'pro1', action: 'skip', reason: 'no_reset_needed' }])
  assert.deepEqual(
    f.calls.filter((c) => c.method === 'POST').map((c) => c.route),
    ['/vms/pro1/claude-reset/query'],
  )
  assert.equal(f.snapshots.length, 0)
  assert.deepEqual(f.state, {})
})

test('account replacement cannot inherit another account reset history', async () => {
  const f = fixture()
  f.state[`pro1:${'b'.repeat(64)}`] = [{ outcome: 'pending' }]
  const r = await maintainFableResets(f)
  assert.equal(r[0].outcome, 'reset')
  assert.equal(f.state[`pro1:${'b'.repeat(64)}`][0].outcome, 'pending')
  assert.equal(f.calls.find((c) => c.route.endsWith('/redeem')).body.auto_reset.account_fingerprint, FP)
})

test('confirmed native preclaim failures do not permanently consume the reset intent', async () => {
  for (const code of [
    'CLAUDE_RESET_PROFILE_FAILED',
    'CLAUDE_RESET_QUERY_FAILED',
    'CLAUDE_RESET_BUSY',
    'CLAUDE_RESET_ACCOUNT_CHANGED',
    'CLAUDE_RESET_ORGANIZATION_INVALID',
    'CLAUDE_RESET_STATUS_INVALID',
    'CLAUDE_RESET_TOKEN_UNAVAILABLE',
    'CLAUDE_RESET_WORKER_UNSUPPORTED',
    'CLAUDE_RESET_PROXY_UNAVAILABLE',
    'CLAUDE_RESET_PROFILE_SCOPE_REQUIRED',
    'CLAUDE_RESET_OAUTH_REQUIRED',
    'CLAUDE_RESET_AUTO_NOT_NEEDED',
    'CLAUDE_RESET_AUTO_CREDIT_CHANGED',
  ]) {
    const f = fixture()
    const native = f.api
    f.api = async (method, route, ...args) => {
      if (route.endsWith('/redeem')) throw Object.assign(Error('native preflight failed'), { code })
      return native(method, route, ...args)
    }
    const first = await maintainFableResets(f)
    assert.equal(first[0].reason, code)
    assert.deepEqual(f.state[STATE_KEY], [], code)
    f.api = native
    const next = await maintainFableResets(f)
    assert.equal(next[0].outcome, 'reset', code)
  }
})

test('transport uncertainty, persistence failure and unresolved native fences retain the intent', async () => {
  for (const code of [
    undefined,
    'panel_http_503',
    'CLAUDE_RESET_STORE_UNAVAILABLE',
    'CLAUDE_RESET_UNRESOLVED',
    'CLAUDE_RESET_UPSTREAM_UNAVAILABLE',
    'unrecognized_error',
  ]) {
    const f = fixture()
    const native = f.api
    f.api = async (method, route, ...args) => {
      if (route.endsWith('/redeem')) throw Object.assign(Error('unknown outcome'), { code })
      return native(method, route, ...args)
    }
    await maintainFableResets(f)
    assert.equal(f.state[STATE_KEY][0].outcome, 'pending', code)
    f.api = native
    const next = await maintainFableResets(f)
    assert.equal(next[0].reason, 'operation_needs_reconciliation', code)
    assert.equal(
      f.calls.some((c) => c.route.endsWith('/redeem')),
      false,
      code,
    )
  }
})

test('slow earlier metadata queries cannot starve later slots using an expired guard snapshot', async () => {
  let clock = NOW
  let guardReads = 0
  const queries = []
  const result = await maintainFableResets({
    enabled: true,
    state: {},
    save: async () => assert.fail('no redemption needed'),
    now: () => clock,
    api: async (_method, route) => {
      if (route === '/vms') return { items: [vm, { ...vm, id: 'pro2' }] }
      if (route === '/proxy-exit-guard') {
        guardReads += 1
        return { proxies: [{ ...guard, state: { ...guard.state, checked_at: new Date(clock).toISOString() } }] }
      }
      if (route.endsWith('/query')) {
        queries.push(route)
        clock += 70000
        return {
          claude_reset_credits: { account_fingerprint: FP, eligible: false, fetched_at: new Date(clock).toISOString() },
        }
      }
      assert.fail(`unexpected ${route}`)
    },
  })
  assert.equal(queries.length, 2)
  assert.equal(guardReads, 2)
  assert.deepEqual(
    result.map((r) => r.reason),
    ['ineligible', 'ineligible'],
  )
})

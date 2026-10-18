import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { mapUpstreamError, quotaWindowError } from '../../src/lib/core/errors.mjs'

const MODEL = 'claude-sonnet-5-5'

function fixture(t, { second = null, grace = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seat-quota-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  for (const id of second ? ['vm-1', 'vm-2'] : ['vm-1']) {
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({
        id,
        status: 'running',
        schedulable: id !== 'vm-2' || second !== 'disabled',
        proxy_cli_enabled: true,
        proxy: { id: `proxy-${id}`, url: 'socks5h://127.0.0.1:11001' },
        runtime: { worker_socket: path.join(root, id, 'absent.sock') },
        policy: { maxConcurrency: 4, concurrencyOverride: true, sessionSlots: 20 },
        claude: {
          account_uuid: `account-${id}`,
          account_tier: 'pro',
          access_token: 'fixture-access',
          refresh_token: 'fixture-refresh',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    )
  }
  const tier = { limit_5h: 0.85, limit_7d: 0.85, max_concurrency: 4 }
  const quota = new AccountQuota({
    dataDir: path.join(root, 'quota'),
    config: {
      quota: { block_on_5h: true, block_on_7d: true, critical_band: 0.05, gate_overshoot: 0.05 },
      tiers: { default: tier, pro: tier, max: tier },
    },
  })
  const states = new Map()
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: {
      get: (id) => states.get(id) || null,
      clearExpired() {},
      upsert: (row) => states.set(row.account_id, { ...states.get(row.account_id), ...row }),
    },
    accountQuota: quota,
    workerHealth: async () => ({ ok: true, healthy: true, ready_slots: 20, credential: { has_access: true } }),
    config: { seat_grace_ms: grace, seat_budget_reserve_pct: 0.02 },
  })
  pool.config.fallback_wait_timeout_ms = 80
  pool.config.sticky_wait_timeout_ms = 80
  const setUsage = (id, window, utilization, reset = new Date(Date.now() + 3600_000).toISOString()) => {
    quota.ingestHeaders(`account-${id}`, {
      [`anthropic-ratelimit-unified-${window}-utilization`]: String(utilization),
      [`anthropic-ratelimit-unified-${window}-status`]: 'allowed',
      ...(reset == null ? {} : { [`anthropic-ratelimit-unified-${window}-reset`]: reset }),
    })
    return reset
  }
  return { pool, quota, setUsage }
}

async function request(pool, { seatKey = 'seat:fresh', ...options } = {}) {
  let calls = 0
  const result = await new FailoverRunner({ scheduler: pool }).run({
    requestId: 'seat-budget-consumer',
    canonicalBody: { model: MODEL, messages: [{ role: 'user', content: 'One plus one?' }] },
    model: MODEL,
    seatKey,
    ...options,
    callAttempt: () => {
      calls++
      return {
        ok: true,
        status: 200,
        terminalState: 'verified',
        body: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: '2' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }
    },
  })
  return { result, calls }
}

for (const window of ['5h', '7d']) {
  test(`${window}: an idle slot without one new seat's quota budget reports local 429 and reset`, async (t) => {
    const { pool, setUsage } = fixture(t)
    const reset = setUsage('vm-1', window, 0.89)
    const { result, calls } = await request(pool)
    assert.equal(calls, 0)
    assert.equal(result.status, 429)
    assert.equal(result.body.error.code, `quota_${window}_seat_budget`)
    assert.match(result.body.error.message, /新会话额度余量不足/)
    assert.equal(result.body.error.details.source, 'local_quota_policy')
    assert.equal(result.body.error.details.window, window)
    assert.equal(result.body.error.details.reset_at, reset)
    assert.ok(result.retryAfterSec >= 3599 && result.retryAfterSec <= 3600)
    const mapped = mapUpstreamError(result.status, result.body, {}, { localQuotaPolicy: result.localQuotaPolicy })
    assert.equal(mapped.status, 429)
    assert.equal(mapped.body.error.code, result.body.error.code)
    assert.equal(mapped.body.error.details.reset_at, reset)
    assert.match(mapped.body.error.message, /新会话额度余量不足/)
    assert.equal(pool.seatSnapshot().global_queue_depth, 0)
    assert.equal(pool.seatSnapshot().seats['vm-1']?.inflight || 0, 0)
  })
}

test('unknown quota reset does not invent Retry-After', async (t) => {
  const { pool, setUsage } = fixture(t)
  setUsage('vm-1', '5h', 0.89, null)
  const { result, calls } = await request(pool)
  assert.equal(calls, 0)
  assert.equal(result.status, 429)
  assert.equal(result.body.error.details.reset_at, null)
  assert.equal(result.retryAfterSec, undefined)
})

test('elapsed window no longer blocks a new seat', async (t) => {
  const { pool, setUsage } = fixture(t)
  setUsage('vm-1', '5h', 0.89, new Date(Date.now() - 1000).toISOString())
  const { result, calls } = await request(pool)
  assert.equal(result.status, 200)
  assert.equal(calls, 1)
})

test('the limiting budget window keeps its own reset when both windows are low', async (t) => {
  const { pool, setUsage } = fixture(t)
  setUsage('vm-1', '5h', 0.84, new Date(Date.now() + 60_000).toISOString())
  const reset = setUsage('vm-1', '7d', 0.89, new Date(Date.now() + 600_000).toISOString())
  const { result, calls } = await request(pool)
  assert.equal(calls, 0)
  assert.equal(result.status, 429)
  assert.equal(result.body.error.code, 'quota_7d_seat_budget')
  assert.equal(result.body.error.details.reset_at, reset)
  assert.ok(result.retryAfterSec >= 599 && result.retryAfterSec <= 600)
})

test('missing usage and an unknown-budget alternative preserve admission', async (t) => {
  const single = fixture(t)
  assert.equal((await request(single.pool)).result.status, 200)
  const { pool, setUsage } = fixture(t, { second: 'ready' })
  setUsage('vm-1', '5h', 0.89)
  const { result, calls } = await request(pool)
  assert.equal(result.status, 200)
  assert.equal(result.vmId, 'vm-2')
  assert.equal(calls, 1)
})

test('the existing large cold-request guard retains its distinct error', async (t) => {
  const { pool, setUsage } = fixture(t)
  setUsage('vm-1', '5h', 0.89)
  const { result, calls } = await request(pool, {
    canonicalBody: { model: MODEL, messages: [{ role: 'user', content: 'x'.repeat(500_000) }] },
  })
  assert.equal(calls, 0)
  assert.equal(result.status, 429)
  assert.equal(result.body.error.code, 'quota_guard_request_too_large')
})

test('a warm seat remains usable at 89%, while a fresh seat at 83% is admitted', async (t) => {
  const { pool, setUsage } = fixture(t, { grace: 30_000 })
  setUsage('vm-1', '5h', 0.83)
  const first = await request(pool, { seatKey: 'seat:warm' })
  assert.equal(first.result.status, 200)
  setUsage('vm-1', '5h', 0.89)
  const warm = await request(pool, { seatKey: 'seat:warm' })
  assert.equal(warm.result.status, 200)
  assert.equal(warm.calls, 1)
  const fresh = await request(pool, { seatKey: 'seat:another' })
  assert.equal(fresh.result.status, 429)
  assert.equal(fresh.calls, 0)
})

test('capacity held by other seats still waits and succeeds after a seat release', async (t) => {
  const { pool, setUsage } = fixture(t)
  setUsage('vm-1', '5h', 0.1)
  const a = await pool.selectAndReserve({ model: MODEL, seatKey: 'seat:a' })
  const b = await pool.selectAndReserve({ model: MODEL, seatKey: 'seat:b' })
  assert.ok(a.ok && b.ok)
  setUsage('vm-1', '5h', 0.8)
  const waiting = request(pool, { seatKey: 'seat:c' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  a.release()
  b.release()
  const { result, calls } = await waiting
  assert.equal(result.status, 200)
  assert.equal(calls, 1)
})

test('an authorized open alternative is used instead of quota rejection', async (t) => {
  const { pool, setUsage } = fixture(t, { second: 'ready' })
  setUsage('vm-1', '5h', 0.89)
  setUsage('vm-2', '5h', 0.1)
  const { result, calls } = await request(pool)
  assert.equal(result.status, 200)
  assert.equal(result.vmId, 'vm-2')
  assert.equal(calls, 1)
})

test('an out-of-scope open slot cannot bypass the key-specific quota refusal', async (t) => {
  const { pool, setUsage } = fixture(t, { second: 'ready' })
  setUsage('vm-1', '5h', 0.89)
  setUsage('vm-2', '5h', 0.1)
  const { result, calls } = await request(pool, { keyScope: { group_type: 'anthropic', allowed_vms: ['vm-1'] } })
  assert.equal(result.status, 429)
  assert.equal(result.body.error.code, 'quota_5h_seat_budget')
  assert.equal(calls, 0)
})

test('mixed nonquota exclusions do not become an all-quota response', async (t) => {
  const { pool, setUsage } = fixture(t, { second: 'disabled' })
  setUsage('vm-1', '5h', 0.89)
  const { result, calls } = await request(pool)
  assert.equal(result.status, 529)
  assert.equal(result.body.error.code, 'pool_overloaded')
  assert.equal(calls, 0)
})

test('seat-budget-shaped external errors cannot claim trusted local quota provenance', () => {
  const body = {
    error: {
      code: 'quota_5h_seat_budget',
      message: 'external failure',
      details: { source: 'local_quota_policy', reset_at: new Date(Date.now() + 60000).toISOString() },
    },
  }
  for (const status of [400, 429, 500, 503]) {
    const mapped = mapUpstreamError(status, body)
    assert.equal(mapped.status, status)
    assert.equal(mapped.localQuotaPolicy, undefined)
    assert.equal(mapped.retryAfterSec, undefined)
  }
})

test('invalid, expired, and out-of-range resets never invent a retry date', () => {
  for (const until of [null, 'invalid', Date.now() - 1000, 1e20, '99999999999999999999', 8640000000000001]) {
    const result = quotaWindowError('quota_5h_seat_budget', { until })
    assert.equal(result.status, 429)
    assert.equal(result.body.error.details.reset_at, null)
    assert.equal(result.retryAfterSec, undefined)
  }
})

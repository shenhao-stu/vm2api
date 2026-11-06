import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { estimateWindow } from '../../src/lib/admin/window-estimate.mjs'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-log-maintenance-'))
  const db = createDatabase({ dbPath: path.join(dir, 'logs.db') })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { db, dir, repo: new UsageLogsRepo(db) }
}

test('attempt begin and completion read only the selected row while preserving the return contract', (t) => {
  const { db } = fixture(t)
  const repo = new RequestAttemptsRepo(db)
  repo.list = () => {
    throw new Error('full request history must not be reread')
  }
  let last
  for (let attemptNo = 1; attemptNo <= 20; attemptNo++) {
    const row = repo.begin({ requestId: 'fixture-request', attemptNo, vmId: 'vm-fixture', waitMs: attemptNo })
    assert.ok(Number.isInteger(row.id))
    assert.equal(row.attempt_no, attemptNo)
    assert.equal(row.request_id, 'fixture-request')
    assert.equal(row.wait_ms, attemptNo)
    assert.equal(row.terminal_state, 'started')
    assert.equal(row.completed_at, null)
    last = repo.complete('fixture-request', attemptNo, {
      upstreamStatus: 200,
      usage: { input_tokens: attemptNo },
      downstreamCommitted: true,
      terminalState: 'verified',
      ttftMs: 10,
    })
    assert.equal(last.id, row.id)
    assert.equal(last.attempt_no, attemptNo)
    assert.equal(last.downstream_committed, true)
    assert.equal(last.upstream_status, 200)
    assert.deepEqual(last.usage, { input_tokens: attemptNo })
  }
  assert.equal(repo.complete('not-present', 1), null)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM request_attempts').get().c, 20)
})

function seedOld(repo, count, { timestamp = new Date(Date.now() - 10 * 86400_000).toISOString() } = {}) {
  for (let i = 0; i < count; i++)
    repo.insertSummary({
      id: `old-${i}`,
      request_id: `old-req-${i}`,
      created_at: timestamp,
      model: 'fixture-model',
      status: 200,
      input_tokens: 10,
    })
  return timestamp
}

test('incremental retention yields between bounded transactions and keeps a conservative same-timestamp gap', async (t) => {
  const { repo, db } = fixture(t)
  const oldTime = seedOld(repo, 1201)
  const fresh = new Date().toISOString()
  repo.insertSummary({ id: 'new', request_id: 'new-req', created_at: fresh, input_tokens: 123, actual_cost: 7 })
  db.prepare("UPDATE schema_migrations SET applied_at=? WHERE version='001'").run(
    new Date(Date.now() - 30 * 86400_000).toISOString(),
  )
  const oldBilling = repo.billingStats()
  let yields = 0,
    partial = false,
    previous = repo.count()
  const result = await repo.cleanupIncremental(
    { retainDays: 7, maxBytes: 0 },
    {
      batchSize: 500,
      yieldControl: async () => {
        await new Promise(setImmediate)
        yields++
        const count = repo.count()
        assert.ok(previous - count <= 500)
        previous = count
        // A separate writer can take a transaction while this cleanup is yielded.
        db.exec('BEGIN IMMEDIATE; ROLLBACK')
        if (count < 1202 && count > 1) {
          partial = true
          assert.equal(repo.logCoverageStart(), null)
          assert.notEqual(repo.billingStats(), oldBilling)
          assert.equal(repo.billingStats().log_coverage_start, null)
          const projection = estimateWindow({
            spentUsd: 7,
            usedRatio: 0.5,
            reset: new Date(Date.now() + 60000).toISOString(),
            windowStart: oldTime,
            coveredSince: repo.logCoverageStart(),
          })
          assert.equal(projection.status, 'log_gap')
        }
      },
    },
  )
  assert.equal(result.usage_logs, 1201)
  assert.equal(repo.count(), 1)
  assert.ok(yields >= 4)
  assert.equal(partial, true)
  assert.ok(Number.isFinite(Date.parse(repo.logCoverageStart())))
  assert.equal(db.prepare("SELECT 1 FROM settings WHERE key='usage_logs_prune_pending'").get(), undefined)
  assert.equal(repo.billingStats().log_coverage_start, repo.logCoverageStart())
  assert.equal(repo.getByRequestId('new-req').input_tokens, 123)
})

test('cancelled same-timestamp pruning persists its gap and a fresh repository sync cleanup completes it', async (t) => {
  const { repo, db } = fixture(t)
  seedOld(repo, 1100)
  const controller = new AbortController()
  let turns = 0
  await assert.rejects(
    repo.cleanupIncremental(
      { retainDays: 7 },
      {
        signal: controller.signal,
        batchSize: 500,
        yieldControl: async () => {
          await new Promise(setImmediate)
          if (++turns === 2) controller.abort()
        },
      },
    ),
    { name: 'AbortError' },
  )
  assert.equal(repo.count(), 600)
  assert.equal(repo.logCoverageStart(), null)
  assert.ok(db.prepare("SELECT 1 FROM settings WHERE key='usage_logs_prune_pending'").get())
  const resumed = new UsageLogsRepo(db)
  assert.equal(resumed.logCoverageStart(), null)
  // Raising retention does not abandon a prune that already removed rows.
  assert.equal(resumed.cleanup({ retainDays: 30 }).usage_logs, 600)
  assert.equal(resumed.count(), 0)
  assert.ok(Number.isFinite(Date.parse(resumed.logCoverageStart())))
  assert.equal(db.prepare("SELECT 1 FROM settings WHERE key='usage_logs_prune_pending'").get(), undefined)
})

test('debug age and UTF-8 size pruning uses bounded batches and only two full size measurements', async (t) => {
  const { repo, db } = fixture(t)
  const fresh = new Date().toISOString(),
    old = new Date(Date.now() - 5 * 86400_000).toISOString()
  for (let i = 0; i < 1201; i++) repo.insertDebug(`old-${i}`, old, { value: 'old' })
  for (let i = 0; i < 1501; i++)
    repo.insertDebug(`new-${String(i).padStart(5, '0')}`, fresh, { value: '中🙂'.repeat(20) })
  const size = repo.debugBytes.bind(repo)
  let measurements = 0,
    yields = 0
  repo.debugBytes = () => {
    measurements++
    return size()
  }
  const cap = 1000
  const result = await repo.cleanupIncremental(
    { retainDays: 7, debugRetainDays: 3, maxBytes: cap },
    {
      batchSize: 200,
      yieldControl: async () => {
        await new Promise(setImmediate)
        yields++
        db.exec('BEGIN; ROLLBACK')
      },
    },
  )
  assert.equal(result.debug_by_age, 1201)
  assert.ok(result.debug_by_size > 1400)
  assert.ok(size() <= cap)
  assert.equal(measurements, 2)
  assert.ok(yields > 10)
  const survivor = db
    .prepare('SELECT request_id FROM request_log_debug ORDER BY ts DESC, request_id DESC LIMIT 1')
    .get()
  assert.equal(survivor.request_id, 'new-01500')
})

test('store maintenance is singleflight and shutdown waits for cancellation before the database closes', async (t) => {
  const { db, dir } = fixture(t)
  const store = new RequestLogStore({ db, dataDir: dir, maxMb: 0 })
  seedOld(store.repo, 1500)
  const first = store.cleanupAsync({ batchSize: 200 })
  assert.equal(store.cleanupAsync({ batchSize: 1 }), first)
  // The initial yield guarantees callers can stop maintenance before it writes.
  store.stopCleanupScheduler()
  await store.waitForCleanup()
  await assert.rejects(first, { name: 'AbortError' })
  assert.equal(store.repo.count(), 1500)
  await new Promise(setImmediate)
  assert.equal(store.repo.count(), 1500)
  const resumed = await store.cleanupAsync({ batchSize: 200 })
  assert.equal(resumed.usage_logs, 1500)
  store.stopCleanupScheduler()
  await store.waitForCleanup()
  assert.equal(store.repo.count(), 0)
})

test('incremental cleanup keeps retained tenant billing and request cost rows unchanged', async (t) => {
  const { db, repo } = fixture(t)
  db.exec(
    "INSERT INTO users (id,email,username,password_hash) VALUES ('u-a','a@fixture.invalid','a','x'),('u-b','b@fixture.invalid','b','x')",
  )
  const fresh = new Date().toISOString()
  repo.insertSummary({
    id: 'tenant-a',
    request_id: 'tenant-a-req',
    created_at: fresh,
    user_id: 'u-a',
    model: 'fixture-model',
    input_tokens: 17,
    total_cost: 3,
    actual_cost: 6,
    rate_multiplier: 2,
  })
  repo.insertSummary({
    id: 'tenant-b',
    request_id: 'tenant-b-req',
    created_at: fresh,
    user_id: 'u-b',
    model: 'fixture-model',
    input_tokens: 19,
    total_cost: 5,
    actual_cost: 15,
    rate_multiplier: 3,
  })
  seedOld(repo, 1501)
  await repo.cleanupIncremental({ retainDays: 7, maxBytes: 0 }, { batchSize: 100 })
  const rows = db
    .prepare(
      'SELECT request_id,user_id,input_tokens,total_cost,actual_cost,rate_multiplier FROM usage_logs ORDER BY id',
    )
    .all()
  assert.deepEqual(
    rows.map((x) => ({ ...x })),
    [
      {
        request_id: 'tenant-a-req',
        user_id: 'u-a',
        input_tokens: 17,
        total_cost: 3,
        actual_cost: 6,
        rate_multiplier: 2,
      },
      {
        request_id: 'tenant-b-req',
        user_id: 'u-b',
        input_tokens: 19,
        total_cost: 5,
        actual_cost: 15,
        rate_multiplier: 3,
      },
    ],
  )
})

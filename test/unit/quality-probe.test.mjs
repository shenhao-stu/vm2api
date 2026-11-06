import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import {
  QualityProbeRunner,
  QUALITY_PROBE_KEY,
  QUALITY_PROBE_PAUSE_REASON,
  QUALITY_RECOVERY_RETRY_MS,
  QUALITY_RECOVERY_CONFIRM_MS,
} from '../../src/lib/admin/quality-probe.mjs'
import { getVm, setScheduleOff, markUnschedulable } from '../../src/lib/vm/vm-registry.mjs'
import { atomicWriteJson } from '../../src/lib/vm/vm-file.mjs'
import { upsertCodexAccount } from '../../src/lib/vm/codex-slot.mjs'
import { tryAcquireOpenAISlot } from '../../src/lib/pool/openai-account-runtime.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

function fixture(t, { runTest, isOwner, now } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-probe-'))
  const db = new DatabaseSync(path.join(root, 'test.db'))
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
  const settings = () => new SettingsRepo(db)
  const calls = []
  let answer = { ok: true, status: 200, stop_reason: 'completed', text: '21' }
  const options = {
    projectRoot: root,
    settings,
    isOwner,
    now,
    runTest: async (id, params) => {
      calls.push({ id, params })
      return runTest ? runTest(id, params) : { ...answer, vm_id: id }
    },
  }
  const runner = new QualityProbeRunner(options)
  t.after(async () => {
    await runner.stop()
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  function seed(id, patch = {}) {
    fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
    atomicWriteJson(path.join(root, 'vms', `${id}.json`), {
      id,
      name: id,
      platform: 'openai',
      family: 'codex',
      status: 'running',
      schedulable: true,
      proxy_cli_enabled: true,
      proxy: { id: 'test-proxy', url: 'socks5h://127.0.0.1:1080', host: '127.0.0.1', port: 1080 },
      codex: { has_access: true },
      ...patch,
    })
    atomicWriteJson(path.join(root, 'vms', id, 'codex-credentials.json'), {
      accounts: [
        {
          email: `${id}@example.invalid`,
          chatgpt_account_id: `account-${id}`,
          access_token: 'fixture-access',
          refresh_token: 'fixture-refresh',
        },
      ],
    })
  }
  runner.saveConfig({ ...runner.snapshot().config, enabled: true })
  seed('vm-a')
  return {
    root,
    runner,
    settings,
    calls,
    seed,
    options,
    answer: (next) => {
      answer = { ...answer, ...next }
    },
    item: (id = 'vm-a') => runner.snapshot().items.find((row) => row.vm_id === id),
  }
}

function deferredProbes() {
  const gates = new Map()
  return {
    runTest: (id) => new Promise((resolve) => gates.set(id, resolve)),
    finish(id, text = '21') {
      const resolve = gates.get(id)
      assert.ok(resolve, `probe ${id} must already be active`)
      gates.delete(id)
      resolve({ vm_id: id, ok: true, status: 200, stop_reason: 'completed', text })
    },
  }
}

const flushProbes = () => new Promise((resolve) => setImmediate(resolve))

test('a legacy multi-account slot cannot attribute a score to its first credential', async (t) => {
  const f = fixture(t)
  const file = path.join(f.root, 'vms', 'vm-a', 'codex-credentials.json')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  saved.accounts.push({ email: 'second@example.invalid', access_token: 'second-fixture' })
  atomicWriteJson(file, saved)
  await f.runner.runNow()
  assert.equal(f.calls.length, 0)
  assert.equal(f.item().last_result, 'skipped')
  assert.equal(f.item().consecutive_wrong, 0)
})

test('unconfigured or invalid persisted probes stay off and never dispatch Fable', async (t) => {
  const f = fixture(t)
  for (const config of [undefined, { enabled: true, model: 'claude-fable' }, { enabled: true, model: 'gpt-fable' }]) {
    f.settings().set(QUALITY_PROBE_KEY, { config, states: {} })
    f.runner.start()
    assert.equal(f.runner.snapshot().config.enabled, false)
    assert.equal(f.runner.timer, null)
    assert.throws(() => f.runner.runNow(), { code: 'quality_probe_disabled' })
  }
  assert.equal(f.calls.length, 0)
})

test('two wrong answers persistently pause only the target, correct answers reset', async (t) => {
  const f = fixture(t)
  f.seed('vm-b')
  f.answer({ text: '29' })
  await f.runner.runNow()
  assert.equal(f.item().consecutive_wrong, 1)
  assert.equal(f.item().paused, false)
  f.answer({ text: '21' })
  await f.runner.runNow()
  assert.equal(f.item().consecutive_wrong, 0)
  f.runner.runTest = async (id) => ({
    vm_id: id,
    ok: true,
    status: 200,
    stop_reason: 'completed',
    text: id === 'vm-a' ? '29' : '21',
  })
  await f.runner.runNow()
  await f.runner.runNow()
  assert.equal(f.item().consecutive_wrong, 2)
  assert.equal(f.item().paused, true)
  assert.equal(f.item('vm-b').paused, false)
  assert.equal(getVm(f.root, 'vm-a').schedule_off_reason, QUALITY_PROBE_PAUSE_REASON)
  const restarted = new QualityProbeRunner(f.options)
  assert.equal(restarted.snapshot().items[0].paused, true)
  assert.equal(restarted.snapshot().items[0].consecutive_wrong, 2)
  f.answer({ text: '21' })
  await restarted.runNow()
  assert.equal(restarted.snapshot().items[0].paused, true)
  assert.equal(restarted.snapshot().items[0].last_result, 'wrong')
  await restarted.stop()
})

test('network, 429, unfinished and empty answers neither add nor clear the wrong streak', async (t) => {
  const f = fixture(t)
  f.answer({ text: '29' })
  await f.runner.runNow()
  for (const result of [
    { ok: false, status: 429 },
    { ok: false, status: 0 },
    { ok: true, status: 200, text: '21', stop_reason: null },
    { ok: true, status: 200, text: '', stop_reason: 'completed' },
    { ok: true, status: 200, text: '21 or 29', stop_reason: 'completed' },
  ]) {
    f.answer(result)
    await f.runner.runNow()
    assert.equal(f.item().consecutive_wrong, 1)
    assert.equal(f.item().paused, false)
  }
  f.answer({ ok: true, status: 200, text: '121', stop_reason: 'completed' })
  await f.runner.runNow()
  assert.equal(f.item().paused, true)
})

test('serial pinned probes expose real progress, reject overlap and omit the expected answer', async (t) => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const f = fixture(t, {
    runTest: async (id) => {
      if (id === 'vm-a') await gate
      return { vm_id: id, ok: true, status: 200, stop_reason: 'completed', text: '21' }
    },
  })
  f.seed('vm-b')
  f.runner.saveConfig({ ...f.runner.snapshot().config, concurrency: 1 })
  const pending = f.runner.runNow()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].id, 'vm-a')
  assert.equal(f.calls[0].params.model, 'gpt-6.1-sol')
  assert.equal(f.calls[0].params.prompt.includes('21'), false)
  assert.equal(f.calls[0].params.timeoutMs, 60_000)
  assert.equal(f.calls[0].params.allowCredentialRefresh, false)
  assert.deepEqual(
    Object.fromEntries(
      ['total', 'completed', 'current_vm_id', 'running'].map((key) => [key, f.runner.snapshot().progress[key]]),
    ),
    { total: 2, completed: 0, current_vm_id: 'vm-a', running: true },
  )
  assert.throws(() => f.runner.runNow(), { code: 'quality_probe_busy' })
  release()
  await pending
  assert.equal(f.calls.length, 2)
  assert.equal(f.runner.snapshot().progress.completed, 2)
  assert.equal(f.runner.snapshot().progress.running, false)
})

test('explicit concurrency probes ten distinct accounts and immediately fills each vacant slot', async (t) => {
  const probes = deferredProbes()
  const f = fixture(t, probes)
  f.runner.saveConfig({ ...f.runner.snapshot().config, concurrency: 10 })
  for (let i = 0; i < 11; i++) f.seed(`vm-b${i.toString().padStart(2, '0')}`)
  const pending = f.runner.runNow()
  assert.equal(f.calls.length, 10)
  const initial = f.calls.map(({ id }) => id)
  assert.equal(new Set(initial).size, 10)
  let progress = f.runner.snapshot().progress
  assert.equal(progress.active_count, 10)
  assert.deepEqual(progress.active_vm_ids, initial)
  // One slow first request must not delay replacement of a different finished request.
  probes.finish(initial[5])
  await flushProbes()
  assert.equal(f.calls.length, 11)
  progress = f.runner.snapshot().progress
  assert.equal(progress.completed, 1)
  assert.equal(progress.active_count, 10)
  assert.equal(progress.active_vm_ids.includes(initial[0]), true)
  assert.equal(progress.active_vm_ids.includes(initial[5]), false)
  probes.finish(initial[6])
  await flushProbes()
  assert.equal(f.calls.length, 12)
  const active = f.runner.snapshot().progress.active_vm_ids
  assert.equal(active.length, 10)
  for (const id of active) probes.finish(id)
  await pending
  assert.equal(f.calls.length, 12)
  assert.equal(new Set(f.calls.map(({ id }) => id)).size, 12)
  progress = f.runner.snapshot().progress
  assert.equal(progress.completed, 12)
  assert.equal(progress.active_count, 0)
  assert.deepEqual(progress.active_vm_ids, [])
})

test('legacy saved config without concurrency uses one and preserves state', async (t) => {
  const f = fixture(t)
  await f.runner.runNow()
  const saved = f.settings().get(QUALITY_PROBE_KEY)
  delete saved.config.concurrency
  f.settings().set(QUALITY_PROBE_KEY, saved)
  assert.equal(f.runner.snapshot().config.concurrency, 1)
  assert.equal(f.item().last_result, 'correct')
  await f.runner.runNow()
  assert.equal(f.item().last_result, 'correct')
})

test('concurrent stop waits for every active probe and dispatches no queued account', async (t) => {
  const probes = deferredProbes()
  const f = fixture(t, probes)
  for (const id of ['vm-b', 'vm-c', 'vm-d', 'vm-e']) f.seed(id)
  f.runner.saveConfig({ ...f.runner.snapshot().config, concurrency: 3 })
  const pending = f.runner.runNow()
  assert.equal(f.calls.length, 3)
  let stopped = false
  const stopping = f.runner.stop().then(() => {
    stopped = true
  })
  probes.finish('vm-b')
  await flushProbes()
  assert.equal(stopped, false)
  assert.equal(f.calls.length, 3)
  assert.equal(f.runner.snapshot().progress.active_count, 2)
  assert.deepEqual(f.runner.snapshot().progress.active_vm_ids, ['vm-a', 'vm-c'])
  probes.finish('vm-a')
  await flushProbes()
  assert.equal(stopped, false)
  probes.finish('vm-c')
  await Promise.all([pending, stopping])
  assert.equal(stopped, true)
  assert.equal(f.calls.length, 3)
  assert.equal(f.runner.snapshot().progress.active_count, 0)
  assert.deepEqual(f.runner.snapshot().progress.active_vm_ids, [])
})

test('configuration change discards every old concurrent answer and stops refilling', async (t) => {
  const probes = deferredProbes()
  const f = fixture(t, probes)
  for (const id of ['vm-b', 'vm-c', 'vm-d']) f.seed(id)
  f.runner.saveConfig({ ...f.runner.snapshot().config, concurrency: 2 })
  const pending = f.runner.runNow()
  assert.equal(f.calls.length, 2)
  f.runner.saveConfig({ ...f.runner.snapshot().config, prompt: '2+2?', expected_answer: '4', concurrency: 1 })
  probes.finish('vm-a', '29')
  await flushProbes()
  assert.equal(f.calls.length, 2)
  assert.equal(f.runner.snapshot().progress.running, true)
  probes.finish('vm-b', '29')
  await pending
  assert.equal(f.calls.length, 2)
  for (const item of f.runner.snapshot().items) {
    assert.equal(item.last_result, null)
    assert.equal(item.consecutive_wrong, 0)
    assert.equal(item.paused, false)
  }
})

test('a worker failure does not finish the round or stop before other active probes settle', async (t) => {
  const probes = deferredProbes()
  const f = fixture(t, probes)
  for (const id of ['vm-b', 'vm-c', 'vm-d']) f.seed(id)
  f.runner.saveConfig({ ...f.runner.snapshot().config, concurrency: 2 })
  const persist = f.runner.record.bind(f.runner)
  f.runner.record = (...args) => {
    if (args[0] === 'vm-a') throw new Error('fixture persist failure')
    return persist(...args)
  }
  let finished = false
  const pending = f.runner.runNow().catch((error) => {
    finished = true
    return error
  })
  probes.finish('vm-a')
  await flushProbes()
  assert.equal(finished, false)
  assert.equal(f.calls.length, 2)
  assert.equal(f.runner.snapshot().progress.running, true)
  assert.deepEqual(f.runner.snapshot().progress.active_vm_ids, ['vm-b'])
  let stopped = false
  const stopping = f.runner.stop().catch((error) => {
    stopped = true
    return error
  })
  await flushProbes()
  assert.equal(stopped, false)
  probes.finish('vm-b')
  const [error, stopError] = await Promise.all([pending, stopping])
  assert.equal(error.message, 'fixture persist failure')
  assert.equal(stopError.message, 'fixture persist failure')
  assert.equal(finished, true)
  assert.equal(stopped, true)
  assert.equal(f.calls.length, 2)
  assert.equal(f.runner.snapshot().progress.active_count, 0)
  assert.deepEqual(f.runner.snapshot().progress.active_vm_ids, [])
})

test('busy, manually paused, auth-invalid, quota-limited and foreign platforms are skipped', async (t) => {
  const f = fixture(t)
  const occupied = tryAcquireOpenAISlot('vm-a')
  t.after(() => occupied.release())
  f.seed('vm-manual')
  setScheduleOff(f.root, 'vm-manual', true, { reason: 'operator-test' })
  f.seed('vm-auth')
  markUnschedulable(f.root, 'vm-auth', 'oauth_revoked')
  f.seed('vm-quota', {
    codex: { has_access: true, extra: { codex_limited_until: new Date(Date.now() + 3600_000).toISOString() } },
  })
  f.seed('vm-claude', { platform: 'anthropic', family: 'claude' })
  await f.runner.runNow()
  assert.equal(f.calls.length, 0)
  assert.equal(f.item().last_result, 'skipped')
  assert.equal(f.item('vm-auth').last_result, 'skipped')
  assert.equal(f.item('vm-claude'), undefined)
  assert.equal(getVm(f.root, 'vm-manual').schedule_off_reason, 'operator-test')
  assert.equal(getVm(f.root, 'vm-auth').unschedulable.reason, 'oauth_revoked')
})

test('changed question discards the old in-flight result and resets counts without reopening paused slots', async (t) => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const f = fixture(t)
  f.answer({ text: '29' })
  await f.runner.runNow()
  f.seed('vm-paused')
  setScheduleOff(f.root, 'vm-paused', true, { reason: QUALITY_PROBE_PAUSE_REASON })
  f.runner.runTest = async (id) => {
    await gate
    return { vm_id: id, ok: true, status: 200, stop_reason: 'completed', text: '29' }
  }
  const pending = f.runner.runNow()
  f.runner.saveConfig({ ...f.runner.snapshot().config, prompt: '2+2?', expected_answer: '4' })
  release()
  await pending
  assert.equal(f.item().consecutive_wrong, 0)
  assert.equal(f.item().last_result, null)
  assert.equal(f.item('vm-paused').paused, true)
})

test('manual pause during a failed probe is not overwritten', async (t) => {
  const f = fixture(t, {
    runTest: async (id) => {
      setScheduleOff(f.root, id, true, { reason: 'operator-test' })
      return { vm_id: id, ok: true, status: 200, stop_reason: 'completed', text: '29' }
    },
  })
  f.runner.saveConfig({ ...f.runner.snapshot().config, failure_threshold: 1 })
  await f.runner.runNow()
  assert.equal(getVm(f.root, 'vm-a').schedule_off_reason, 'operator-test')
  assert.equal(f.item().paused, false)
})

test('replacing an account during a probe discards the old answer and streak', async (t) => {
  const f = fixture(t)
  f.answer({ text: '29' })
  await f.runner.runNow()
  assert.equal(f.item().consecutive_wrong, 1)
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  f.runner.runTest = async (id) => {
    await gate
    return { vm_id: id, ok: true, status: 200, stop_reason: 'completed', text: '29' }
  }
  const pending = f.runner.runNow()
  // Simulate an old external writer; the normal import API rejects account rebinding.
  atomicWriteJson(path.join(f.root, 'vms', 'vm-a', 'codex-credentials.json'), {
    accounts: [
      {
        email: 'replacement@example.invalid',
        chatgpt_account_id: 'replacement',
        access_token: 'replacement-access',
      },
    ],
  })
  assert.equal(f.item().consecutive_wrong, 0)
  release()
  await pending
  assert.equal(f.item().consecutive_wrong, 0)
  assert.equal(f.item().last_result, null)
  assert.equal(f.item().paused, false)
  assert.equal(getVm(f.root, 'vm-a').schedulable, true)
})

test('a replacement account starts a new streak but ordinary token refresh retains it', async (t) => {
  const f = fixture(t)
  f.answer({ text: '29' })
  await f.runner.runNow()
  // Simulate an old external writer while keeping the production binding guard intact.
  atomicWriteJson(path.join(f.root, 'vms', 'vm-a', 'codex-credentials.json'), {
    accounts: [
      {
        email: 'new@example.invalid',
        chatgpt_account_id: 'new',
        access_token: 'new-access',
        refresh_token: 'new-refresh',
      },
    ],
  })
  await f.runner.runNow()
  assert.equal(f.item().consecutive_wrong, 1)
  assert.equal(f.item().paused, false)
  upsertCodexAccount(f.root, 'vm-a', { access_token: 'rotated-access', refresh_token: 'rotated-refresh' })
  await f.runner.runNow()
  assert.equal(f.item().consecutive_wrong, 2)
  assert.equal(f.item().paused, true)
})

test('shutdown waits for the current probe, then stops before dispatching the next account', async (t) => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const f = fixture(t, {
    runTest: async (id) => {
      await gate
      return { vm_id: id, ok: false, status: 503 }
    },
  })
  f.seed('vm-b')
  f.runner.saveConfig({ ...f.runner.snapshot().config, concurrency: 1 })
  const pending = f.runner.runNow()
  let stopped = false
  const stopping = f.runner.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  assert.equal(stopped, false)
  release()
  await Promise.all([pending, stopping])
  assert.equal(stopped, true)
  assert.equal(f.calls.length, 1)
  assert.equal(f.runner.snapshot().progress.next_run_at, null)
})

test('owner-only timer defaults to 15 minutes and disabled settings prevent dispatch', async (t) => {
  const clock = Date.now()
  const f = fixture(t, { now: () => clock })
  f.runner.start()
  assert.equal(Date.parse(f.runner.snapshot().progress.next_run_at) - clock, 15 * 60_000)
  f.runner.saveConfig({ ...f.runner.snapshot().config, interval_minutes: 5 })
  assert.equal(Date.parse(f.runner.snapshot().progress.next_run_at) - clock, 5 * 60_000)
  f.runner.saveConfig({ ...f.runner.snapshot().config, enabled: false })
  assert.equal(f.runner.snapshot().progress.next_run_at, null)
  assert.throws(() => f.runner.runNow(), { code: 'quality_probe_disabled' })
  const frontend = new QualityProbeRunner({ ...f.options, isOwner: () => false })
  frontend.start()
  assert.equal(frontend.timer, null)
  assert.throws(() => frontend.runNow(), { code: 'owner_unavailable' })
})

test('an unexpected target id cannot contribute a score', async (t) => {
  const f = fixture(t, {
    runTest: async () => ({ vm_id: 'vm-other', ok: true, status: 200, stop_reason: 'completed', text: '29' }),
  })
  await f.runner.runNow()
  assert.equal(f.item().last_result, 'invalid')
  assert.equal(f.item().consecutive_wrong, 0)
})

test('a zero-account round finishes with zero progress', async (t) => {
  const f = fixture(t)
  fs.unlinkSync(path.join(f.root, 'vms', 'vm-a.json'))
  await f.runner.runNow()
  assert.equal(f.runner.snapshot().progress.total, 0)
  assert.equal(f.runner.snapshot().progress.completed, 0)
  assert.equal(f.calls.length, 0)
})

async function panelRequest(f, method, url, body = {}, role = 'admin') {
  const response = {}
  const handler = createPanelHandler({
    cfg: { paths: { project: f.root }, vm: { id: null } },
    qualityProbe: f.runner,
    requireAuth(req) {
      req.panelRole = role
      if (role === 'admin') req.apiKeyKind = 'master'
      return true
    },
    readBody: async () => body,
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
  })
  await handler({ method }, {}, new URL(url, 'http://localhost'))
  return response
}

test('admin endpoints persist settings, start a real runner and reject invalid/non-admin writes', async (t) => {
  const f = fixture(t)
  const view = await panelRequest(f, 'GET', '/api/panel/quality-probe')
  assert.equal(view.status, 200)
  assert.equal(view.body.data.config.failure_threshold, 2)
  const config = { ...view.body.data.config, interval_minutes: 30, failure_threshold: 3 }
  const update = await panelRequest(f, 'PUT', '/api/panel/quality-probe', config)
  assert.equal(update.status, 200)
  assert.equal(update.body.data.config.interval_minutes, 30)
  const invalid = await panelRequest(f, 'PUT', '/api/panel/quality-probe', { ...config, failure_threshold: 0 })
  assert.equal(invalid.status, 400)
  assert.equal(f.runner.snapshot().config.failure_threshold, 3)
  for (const role of ['user', 'super']) {
    for (const method of ['GET', 'PUT', 'POST']) {
      const url = method === 'POST' ? '/api/panel/quality-probe/run' : '/api/panel/quality-probe'
      assert.equal((await panelRequest(f, method, url, config, role)).status, 403)
    }
  }
  const manual = await panelRequest(f, 'POST', '/api/panel/quality-probe/run')
  assert.equal(manual.status, 202)
  await f.runner.running
  assert.equal(f.item().last_result, 'correct')
})

test('manual resume resets the streak but preserves unrelated auth restrictions', async (t) => {
  const f = fixture(t)
  f.answer({ text: '29' })
  await f.runner.runNow()
  await f.runner.runNow()
  markUnschedulable(f.root, 'vm-a', 'oauth_revoked')
  const result = await panelRequest(f, 'POST', '/api/panel/vms/vm-a/schedulable', {
    schedulable: true,
    expected_reason: QUALITY_PROBE_PAUSE_REASON,
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.data.schedulable, false)
  assert.equal(getVm(f.root, 'vm-a').unschedulable.reason, 'oauth_revoked')
  assert.equal(f.item().paused, false)
  assert.equal(f.item().consecutive_wrong, 0)
  await f.runner.runNow()
  assert.equal(f.item().last_result, 'skipped')
})

test('a stale quality resume cannot clear a newer manual pause or authentication restriction', async (t) => {
  const f = fixture(t)
  f.answer({ text: '29' })
  await f.runner.runNow()
  await f.runner.runNow()
  markUnschedulable(f.root, 'vm-a', 'oauth_revoked')
  setScheduleOff(f.root, 'vm-a', true, { reason: 'operator-test' })
  const result = await panelRequest(f, 'POST', '/api/panel/vms/vm-a/schedulable', {
    schedulable: true,
    expected_reason: QUALITY_PROBE_PAUSE_REASON,
  })
  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'schedule_state_changed')
  assert.equal(getVm(f.root, 'vm-a').schedule_off_reason, 'operator-test')
  assert.equal(getVm(f.root, 'vm-a').unschedulable.reason, 'oauth_revoked')
  assert.equal(f.item().consecutive_wrong, 2)
})

async function recoveryFixture(t) {
  let clock = Date.parse('2026-11-01T00:00:00Z')
  const f = fixture(t, { now: () => clock })
  f.runner.saveConfig({ ...f.runner.snapshot().config, failure_threshold: 1 })
  f.answer({ text: '23' })
  await f.runner.runNow()
  f.answer({ text: '21' })
  return { ...f, advance: (ms) => (clock += ms), now: () => clock }
}

test('recovery waits 24h then requires two correct answers 10m apart from completion, across restart', async (t) => {
  const f = await recoveryFixture(t)
  assert.equal(Date.parse(f.item().recovery_next_at), f.now() + QUALITY_RECOVERY_RETRY_MS)
  f.advance(QUALITY_RECOVERY_RETRY_MS - 1)
  await f.runner.runNow()
  assert.equal(f.calls.length, 1, 'manual run cannot bypass the cooldown')
  f.advance(1)
  f.runner.runTest = async (id, params) => {
    assert.equal(params.allowCredentialRefresh, false)
    f.advance(45_000)
    return { vm_id: id, ok: true, status: 200, stop_reason: 'completed', text: '21' }
  }
  await f.runner.runNow()
  const first = f.item()
  assert.equal(first.recovery_phase, 'confirming')
  assert.equal(first.paused, true)
  assert.equal(first.consecutive_wrong, 1)
  assert.equal(Date.parse(first.recovery_first_pass_at), f.now())
  assert.equal(Date.parse(first.recovery_next_at), f.now() + QUALITY_RECOVERY_CONFIRM_MS)
  const restarted = new QualityProbeRunner(f.options)
  t.after(() => restarted.stop())
  assert.equal(restarted.snapshot().items[0].recovery_next_at, first.recovery_next_at)
  f.advance(QUALITY_RECOVERY_CONFIRM_MS - 1)
  await restarted.runNow()
  assert.equal(restarted.snapshot().items[0].paused, true)
  f.advance(1)
  await restarted.runNow()
  const recovered = restarted.snapshot().items[0]
  assert.equal(recovered.recovery_phase, 'recovered')
  assert.equal(recovered.paused, false)
  assert.equal(recovered.consecutive_wrong, 0)
  assert.equal(getVm(f.root, 'vm-a').schedulable, true)
  assert.equal(recovered.recovery_next_at, null)
  assert.deepEqual(
    recovered.recovery_history.map((row) => row.event),
    ['paused', 'probing', 'first_pass', 'probing', 'recovered'],
  )
})

test('wrong, request error and invalid confirmation each restart 24h; technical failures never add wrong', async (t) => {
  for (const [name, answer, wrongCount] of [
    ['wrong', { text: '23' }, 2],
    ['error', { ok: false, status: 429 }, 1],
    ['invalid', { text: '21 or 23' }, 1],
  ]) {
    await t.test(name, async (t) => {
      const f = await recoveryFixture(t)
      f.advance(QUALITY_RECOVERY_RETRY_MS)
      await f.runner.runNow()
      f.advance(QUALITY_RECOVERY_CONFIRM_MS)
      f.answer(answer)
      await f.runner.runNow()
      const item = f.item()
      assert.equal(item.paused, true)
      assert.equal(item.recovery_phase, 'cooldown')
      assert.equal(item.recovery_first_pass_at, null)
      assert.equal(Date.parse(item.recovery_next_at), f.now() + QUALITY_RECOVERY_RETRY_MS)
      assert.equal(item.consecutive_wrong, wrongCount)
      assert.equal(item.recovery_history.at(-1).result, name)
    })
  }
})

test('legacy quality pauses migrate once from failing time, unknown evidence starts a fresh 24h', async (t) => {
  const f = await recoveryFixture(t)
  const saved = f.settings().get(QUALITY_PROBE_KEY)
  for (const key of Object.keys(saved.states['vm-a'])) {
    if (key.startsWith('recovery_')) delete saved.states['vm-a'][key]
  }
  f.settings().set(QUALITY_PROBE_KEY, saved)
  f.advance(30 * 60_000)
  const migrated = f.item()
  assert.equal(Date.parse(migrated.recovery_next_at), Date.parse(migrated.last_test_at) + QUALITY_RECOVERY_RETRY_MS)
  assert.equal(migrated.recovery_history.at(-1).event, 'scheduled')
  f.advance(60_000)
  assert.equal(f.item().recovery_next_at, migrated.recovery_next_at)
  const unknown = f.settings().get(QUALITY_PROBE_KEY)
  unknown.states['vm-a'].last_test_at = 'invalid'
  unknown.states['vm-a'].recovery_phase = null
  unknown.states['vm-a'].recovery_next_at = null
  f.settings().set(QUALITY_PROBE_KEY, unknown)
  assert.equal(Date.parse(f.item().recovery_next_at), f.now() + QUALITY_RECOVERY_RETRY_MS)
})

test('crashed in-flight recovery resumes its persisted confirmation deadline', async (t) => {
  const f = await recoveryFixture(t)
  f.advance(QUALITY_RECOVERY_RETRY_MS)
  await f.runner.runNow()
  const due = f.item().recovery_next_at
  const saved = f.settings().get(QUALITY_PROBE_KEY)
  saved.states['vm-a'].recovery_phase = 'probing'
  f.settings().set(QUALITY_PROBE_KEY, saved)
  const restarted = new QualityProbeRunner(f.options)
  t.after(() => restarted.stop())
  const item = restarted.snapshot().items[0]
  assert.equal(item.recovery_phase, 'confirming')
  assert.equal(item.recovery_next_at, due)
  f.advance(QUALITY_RECOVERY_CONFIRM_MS)
  await restarted.runNow()
  assert.equal(restarted.snapshot().items[0].recovery_phase, 'recovered')
})

test('recovery-only timer wakes the due account without probing healthy accounts or shifting normal cadence', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await recoveryFixture(t)
  f.seed('vm-b')
  f.advance(QUALITY_RECOVERY_RETRY_MS - 1000)
  const saved = f.settings().get(QUALITY_PROBE_KEY)
  saved.next_run_at = new Date(f.now() + 60 * 60_000).toISOString()
  f.settings().set(QUALITY_PROBE_KEY, saved)
  f.runner.start()
  assert.equal(f.runner.wake.recoveryOnly, true)
  f.advance(1000)
  t.mock.timers.tick(1000)
  await f.runner.running
  assert.deepEqual(
    f.calls.map(({ id }) => id),
    ['vm-a', 'vm-a'],
  )
  assert.equal(f.settings().get(QUALITY_PROBE_KEY).next_run_at, saved.next_run_at)
  assert.equal(f.runner.wake.at, f.item().recovery_next_at)
  f.advance(QUALITY_RECOVERY_CONFIRM_MS)
  t.mock.timers.tick(QUALITY_RECOVERY_CONFIRM_MS)
  await f.runner.running
  assert.equal(f.item().recovery_phase, 'recovered')
  assert.equal(f.calls.filter(({ id }) => id === 'vm-b').length, 0)
  assert.equal(f.runner.wake.at, saved.next_run_at)
})

test('disabled quality probing also suspends recovery while retaining its deadline', async (t) => {
  const f = await recoveryFixture(t)
  const due = f.item().recovery_next_at
  f.runner.start()
  f.runner.saveConfig({ ...f.runner.snapshot().config, enabled: false })
  f.advance(QUALITY_RECOVERY_RETRY_MS)
  assert.equal(f.runner.timer, null)
  assert.throws(() => f.runner.runNow(), { code: 'quality_probe_disabled' })
  assert.equal(f.item().recovery_next_at, due)
  assert.equal(f.calls.length, 1)
})

test('configuration changes discard an in-flight recovery answer and its previous first pass', async (t) => {
  const f = await recoveryFixture(t)
  f.advance(QUALITY_RECOVERY_RETRY_MS)
  await f.runner.runNow()
  f.advance(QUALITY_RECOVERY_CONFIRM_MS)
  let finish
  f.runner.runTest = (id) =>
    new Promise((resolve) => {
      finish = () => resolve({ vm_id: id, ok: true, status: 200, stop_reason: 'completed', text: '21' })
    })
  const pending = f.runner.runNow()
  assert.equal(f.item().recovery_phase, 'probing')
  f.runner.saveConfig({ ...f.runner.snapshot().config, prompt: '2+2?', expected_answer: '4' })
  finish()
  await pending
  assert.equal(f.item().paused, true)
  assert.equal(f.item().last_result, null)
  assert.equal(f.item().recovery_phase, 'cooldown')
  assert.equal(f.item().recovery_first_pass_at, null)
  assert.equal(Date.parse(f.item().recovery_next_at), f.now() + QUALITY_RECOVERY_RETRY_MS)
})

test('recovery preserves a newer manual pause and other restrictions added during the confirmation', async (t) => {
  for (const manual of [true, false])
    await t.test(manual ? 'manual pause' : 'auth restriction', async (t) => {
      const f = await recoveryFixture(t)
      f.advance(QUALITY_RECOVERY_RETRY_MS)
      await f.runner.runNow()
      f.advance(QUALITY_RECOVERY_CONFIRM_MS)
      f.runner.runTest = async (id) => {
        markUnschedulable(f.root, id, 'oauth_revoked')
        const vm = getVm(f.root, id)
        atomicWriteJson(path.join(f.root, 'vms', `${id}.json`), { ...vm, status: 'error' })
        if (manual) setScheduleOff(f.root, id, true, { reason: 'operator-test' })
        return { vm_id: id, ok: true, status: 200, stop_reason: 'completed', text: '21' }
      }
      await f.runner.runNow()
      const vm = getVm(f.root, 'vm-a')
      assert.equal(vm.unschedulable.reason, 'oauth_revoked')
      assert.equal(vm.status, 'error')
      assert.equal(vm.schedulable, false)
      assert.equal(vm.schedule_off_reason, manual ? 'operator-test' : undefined)
      assert.equal(f.item().recovery_phase, manual ? null : 'recovered')
    })
})

test('blocked credentials, proxy and quota never bypass eligibility to send a recovery request', async (t) => {
  for (const restriction of ['auth', 'proxy', 'quota'])
    await t.test(restriction, async (t) => {
      const f = await recoveryFixture(t)
      f.advance(QUALITY_RECOVERY_RETRY_MS)
      if (restriction === 'auth') markUnschedulable(f.root, 'vm-a', 'oauth_revoked')
      else {
        const vm = getVm(f.root, 'vm-a')
        const patch =
          restriction === 'proxy'
            ? { proxy: { host: '::1', port: 1080 } }
            : {
                codex_limited_until: new Date(f.now() + 60_000).toISOString(),
              }
        atomicWriteJson(path.join(f.root, 'vms', 'vm-a.json'), { ...vm, ...patch })
      }
      await f.runner.runNow()
      assert.equal(f.calls.length, 1)
      assert.equal(f.item().paused, true)
      assert.equal(f.item().consecutive_wrong, 1)
      assert.equal(f.item().recovery_history.at(-1).event, 'blocked')
      assert.equal(Date.parse(f.item().recovery_next_at), f.now() + QUALITY_RECOVERY_RETRY_MS)
    })
})

test('replacement identity cannot inherit recovery evidence while ordinary token rotation retains it', async (t) => {
  const f = await recoveryFixture(t)
  f.advance(QUALITY_RECOVERY_RETRY_MS)
  await f.runner.runNow()
  upsertCodexAccount(f.root, 'vm-a', { access_token: 'rotated-access', refresh_token: 'rotated-refresh' })
  assert.equal(f.item().recovery_phase, 'confirming')
  f.advance(QUALITY_RECOVERY_CONFIRM_MS)
  f.runner.runTest = async (id) => {
    atomicWriteJson(path.join(f.root, 'vms', id, 'codex-credentials.json'), {
      accounts: [{ email: 'replacement@example.invalid', chatgpt_account_id: 'replacement', access_token: 'new' }],
    })
    return { vm_id: id, ok: true, status: 200, stop_reason: 'completed', text: '21' }
  }
  await f.runner.runNow()
  assert.equal(f.item().paused, true)
  assert.equal(f.item().last_result, null)
  assert.equal(f.item().recovery_phase, 'cooldown')
  assert.equal(Date.parse(f.item().recovery_next_at), f.now() + QUALITY_RECOVERY_RETRY_MS)
})

test('recovery history is bounded, survives manual resume and server logs exclude credentials and answers', async (t) => {
  const logs = t.mock.method(console, 'info', () => {})
  const f = await recoveryFixture(t)
  f.answer({ ok: false, status: 429 })
  for (let i = 0; i < 12; i++) {
    f.advance(QUALITY_RECOVERY_RETRY_MS)
    await f.runner.runNow()
  }
  assert.equal(f.item().recovery_history.length, 20)
  const result = await panelRequest(f, 'POST', '/api/panel/vms/vm-a/schedulable', {
    schedulable: true,
    expected_reason: QUALITY_PROBE_PAUSE_REASON,
  })
  assert.equal(result.status, 200)
  assert.equal(f.item().recovery_history.length, 20)
  assert.equal(f.item().recovery_history.at(-1).event, 'manual_reset')
  const text = JSON.stringify(logs.mock.calls.map((call) => call.arguments))
  assert.match(text, /quality-probe-recovery/)
  assert.doesNotMatch(text, /fixture-access|fixture-refresh|last_answer|expected_answer|只输出/)
})

test('dual detection pauses a non-Luna request on an explicit true even when its answer is correct', async (t) => {
  const logs = t.mock.method(console, 'info', () => {})
  const f = fixture(t)
  f.runner.saveConfig({ ...f.runner.snapshot().config, failure_threshold: 100 })
  f.answer({
    debug: {
      safety_buffering: true,
      upstream_model: 'gpt-6.1-sol',
      safety_buffering_enabled: 'true',
      safety_buffering_faster_model: 'gpt-6-luna',
    },
  })
  await f.runner.runNow()
  assert.equal(f.item().last_result, 'correct')
  assert.equal(f.item().consecutive_wrong, 0)
  assert.equal(f.item().paused, true)
  assert.equal(f.item().quality_pause_trigger, 'safety_buffering')
  assert.equal(f.item().safety_buffering, true)
  assert.equal(f.item().upstream_model, 'gpt-6.1-sol')
  assert.equal(f.item().recovery_history.at(-1).result, 'safety_buffering')
  const observation = logs.mock.calls.find((call) => call.arguments[0] === '[quality-probe-measurement]')
  const record = JSON.parse(observation.arguments[1])
  assert.equal(record.requested_model, 'gpt-6.1-sol')
  assert.equal(record.safety_pause, true)
  assert.equal(record.safety_buffering_faster_model, 'gpt-6-luna')
})

test('false, missing and string safety flags never pause based on enabled/faster-model headers', async (t) => {
  for (const signal of [false, undefined, 'true'])
    await t.test(String(signal), async (t) => {
      const f = fixture(t)
      f.answer({
        debug: {
          safety_buffering: signal,
          safety_buffering_enabled: 'true',
          safety_buffering_faster_model: 'gpt-6-luna',
          upstream_model: 'response-model',
        },
      })
      await f.runner.runNow()
      assert.equal(f.item().paused, false)
      assert.equal(f.item().safety_buffering, signal === false ? false : null)
      assert.equal(f.item().upstream_model, 'response-model')
    })
})

test('requesting Luna records true without triggering the safety pause', async (t) => {
  const f = fixture(t)
  f.runner.saveConfig({ ...f.runner.snapshot().config, model: 'gpt-6-luna' })
  f.answer({ debug: { safety_buffering: true, upstream_model: 'gpt-6-luna' } })
  await f.runner.runNow()
  assert.equal(f.calls.length, 1)
  assert.equal(f.item().safety_buffering, true)
  assert.equal(f.item().paused, false)
})

test('a buffering flag attributed to another account cannot pause the pinned target', async (t) => {
  const f = fixture(t, {
    runTest: async (id) => ({
      vm_id: id,
      ok: false,
      status: 502,
      debug: { hit_vm: 'another-account', safety_buffering: true },
    }),
  })
  await f.runner.runNow()
  assert.equal(f.item().paused, false)
  assert.equal(f.item().last_result, 'invalid')
  assert.equal(f.item().safety_buffering, null)
})

test('explicit buffering restarts recovery even on a correct answer; unknown remains eligible', async (t) => {
  const f = await recoveryFixture(t)
  f.advance(QUALITY_RECOVERY_RETRY_MS)
  f.answer({ debug: { safety_buffering: true } })
  await f.runner.runNow()
  assert.equal(f.item().recovery_phase, 'cooldown')
  assert.equal(f.item().recovery_first_pass_at, null)
  assert.equal(f.item().recovery_history.at(-1).result, 'safety_buffering')
  assert.equal(f.item().consecutive_wrong, 1)
  f.advance(QUALITY_RECOVERY_RETRY_MS)
  f.answer({ debug: { safety_buffering: false } })
  await f.runner.runNow()
  assert.equal(f.item().recovery_phase, 'confirming')
  f.advance(QUALITY_RECOVERY_CONFIRM_MS)
  f.answer({ debug: { safety_buffering: true } })
  await f.runner.runNow()
  assert.equal(f.item().recovery_phase, 'cooldown')
  assert.equal(f.item().paused, true)
  f.advance(QUALITY_RECOVERY_RETRY_MS)
  f.answer({ debug: {} })
  await f.runner.runNow()
  assert.equal(f.item().recovery_phase, 'confirming')
  f.advance(QUALITY_RECOVERY_CONFIRM_MS)
  await f.runner.runNow()
  assert.equal(f.item().recovery_phase, 'recovered')
  assert.equal(f.item().paused, false)
})

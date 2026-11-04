import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { powerOnSlot } from '../../src/lib/vm/slot-recovery.mjs'
import { evaluateProxyExitGuardState } from '../../src/lib/vm/proxy-exit-guard.mjs'
import { patchVmRecord } from '../../src/lib/vm/vm-registry.mjs'

const proxy = {
  id: 'px-recovery',
  host: '127.0.0.1',
  port: 38001,
  scheme: 'socks5',
}
const policy = {
  required: true,
  expected_ip: '203.0.113.9',
  revision: 'operator-rearm-same-ip',
}
function guard(patch = {}, options = {}) {
  const now = Date.now()
  return evaluateProxyExitGuardState(
    {
      expected_ip: policy.expected_ip,
      observed_ip: policy.expected_ip,
      revision: policy.revision,
      ready: true,
      latched: false,
      checked_at: new Date(now).toISOString(),
      socks_addr: '127.0.0.1:38001',
      ...patch,
    },
    policy,
    { now, processActive: true, ...options },
  )
}
const healthyBoot = {
  ok: true,
  rust_ok: true,
  rust: { ok: true, engine: 'rust', rust: { ok: true } },
}
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-hold-recovery-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  const vm = {
    id: 'vm-held',
    status: 'running',
    runtime: { type: 'docker' },
    proxy,
    claude: { has_access: true, has_refresh: true },
    schedulable: false,
    schedule_hold: {
      reason: 'proxy_cooldown',
      detail: {
        tag: proxy.id,
        message: 'egress_down:exit_guard_restart_requires_rearm',
      },
    },
    ...extra,
  }
  const file = path.join(root, 'vms', `${vm.id}.json`)
  fs.writeFileSync(file, JSON.stringify(vm))
  return {
    root,
    vm,
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    options: {
      projectRoot: root,
      id: vm.id,
      proxyPool: { ensureBoundToVm: () => proxy },
      fillTimezone: async () => {},
    },
  }
}

for (const by of ['start', 'recover_ok']) {
  test(`operator ${by} clears only the matching proxy hold after fresh guard and runtime readiness`, async (t) => {
    const f = fixture(t)
    let booted = false
    const result = await powerOnSlot({
      ...f.options,
      by,
      ops: {
        startSlotReady: async () => {
          booted = true
          return healthyBoot
        },
        getProxyExitGuardState: (root, id) => {
          assert.equal(booted, true)
          assert.equal(root, f.root)
          assert.equal(id, proxy.id)
          return guard()
        },
      },
    })
    assert.equal(result.ok, true)
    assert.equal(f.read().schedule_hold, undefined)
    assert.equal(f.read().schedulable, true)
  })
}

test('probe/watchdog boot never performs the operator-only proxy recovery', async (t) => {
  const f = fixture(t)
  await powerOnSlot({
    ...f.options,
    ops: {
      startSlotReady: async () => healthyBoot,
      getProxyExitGuardState: () => guard(),
    },
  })
  assert.equal(f.read().schedule_hold.reason, 'proxy_cooldown')
  assert.equal(f.read().schedulable, false)
})

test('changed IP, latched, stale, dead helper or unavailable guard cannot clear the proxy hold', async (t) => {
  const cases = [
    () => guard({ observed_ip: '203.0.113.10' }),
    () => guard({ latched: true }),
    () => guard({ checked_at: new Date(Date.now() - 60_000).toISOString() }),
    () => guard({}, { processActive: false }),
    () => ({ required: false, ready: true }),
    () => {
      throw new Error('guard unavailable')
    },
  ]
  for (const readGuard of cases) {
    const f = fixture(t)
    await powerOnSlot({
      ...f.options,
      by: 'start',
      ops: {
        startSlotReady: async () => healthyBoot,
        getProxyExitGuardState: readGuard,
      },
    })
    assert.equal(f.read().schedule_hold.reason, 'proxy_cooldown')
    assert.equal(f.read().schedulable, false)
  }
})

test('failed or skipped runtime and credential-less slots retain their proxy hold', async (t) => {
  for (const boot of [
    { ok: false, error: 'boot failed' },
    { ok: true, rust_ok: false, rust: { ok: false } },
    {
      ok: true,
      rust_ok: true,
      rust: { ok: true, skipped: true, reason: 'eager_start_off' },
    },
    { ok: true },
  ]) {
    const f = fixture(t)
    await powerOnSlot({
      ...f.options,
      by: 'start',
      ops: {
        startSlotReady: async () => boot,
        getProxyExitGuardState: () => guard(),
      },
    })
    assert.equal(f.read().schedule_hold.reason, 'proxy_cooldown')
    assert.equal(f.read().schedulable, false)
  }
  const f = fixture(t, { claude: {} })
  await powerOnSlot({
    ...f.options,
    by: 'start',
    ops: {
      startSlotReady: async () => healthyBoot,
      getProxyExitGuardState: () => guard(),
    },
  })
  assert.equal(f.read().schedule_hold.reason, 'proxy_cooldown')
  assert.equal(f.read().unschedulable.reason, 'no_credential')
  assert.equal(f.read().schedulable, false)
})

test('manual off, credential failures, other holds and another proxy tag stay protected', async (t) => {
  for (const extra of [
    { schedule_off: true, schedule_off_reason: 'waiting_cookie' },
    { unschedulable: { reason: 'oauth_revoked' } },
  ]) {
    for (const by of ['start', 'recover_ok']) {
      const f = fixture(t, extra)
      await powerOnSlot({
        ...f.options,
        by,
        ops: {
          startSlotReady: async () => healthyBoot,
          getProxyExitGuardState: () => guard(),
        },
      })
      assert.equal(f.read().schedulable, false)
      for (const [key, value] of Object.entries(extra)) assert.deepEqual(f.read()[key], value)
    }
  }
  for (const hold of [
    { reason: 'maintenance', detail: { tag: 'worker_update' } },
    { reason: 'proxy_cooldown', detail: { tag: 'px-other' } },
    { reason: 'proxy_cooldown', detail: { tag: null } },
  ]) {
    const f = fixture(t, { schedule_hold: hold })
    await powerOnSlot({
      ...f.options,
      by: 'start',
      ops: {
        startSlotReady: async () => healthyBoot,
        getProxyExitGuardState: () => guard(),
      },
    })
    assert.deepEqual(f.read().schedule_hold, hold)
  }
})

test('rebind or a concurrent proxy/credential change during boot cannot clear old protection', async (t) => {
  const old = fixture(t, { proxy: { ...proxy, id: 'px-old' } })
  await powerOnSlot({
    ...old.options,
    by: 'start',
    ops: {
      startSlotReady: async () => healthyBoot,
      getProxyExitGuardState: () => guard(),
    },
  })
  assert.equal(old.read().schedule_hold.reason, 'proxy_cooldown')
  for (const patch of [{ proxy: { ...proxy, id: 'px-other' } }, { claude: {} }]) {
    const f = fixture(t)
    await powerOnSlot({
      ...f.options,
      by: 'start',
      ops: {
        startSlotReady: async () => {
          patchVmRecord(f.root, f.vm.id, patch)
          return healthyBoot
        },
        getProxyExitGuardState: () => guard(),
      },
    })
    assert.equal(f.read().schedule_hold.reason, 'proxy_cooldown')
    assert.equal(f.read().schedulable, false)
  }
})

test('a successful explicit boot may still clear runtime_start_failed with its matching proxy hold', async (t) => {
  for (const by of ['start', 'recover_ok']) {
    const f = fixture(t, { unschedulable: { reason: 'runtime_start_failed' } })
    await powerOnSlot({
      ...f.options,
      by,
      ops: { startSlotReady: async () => healthyBoot, getProxyExitGuardState: () => guard() },
    })
    assert.equal(f.read().unschedulable, undefined)
    assert.equal(f.read().schedule_hold, undefined)
    assert.equal(f.read().schedulable, true)
  }
})

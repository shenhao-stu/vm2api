import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { updateOneSlot } from '../../src/lib/vm/fleet-update.mjs'
import {
  startRemoteSlot,
  reloadRemoteSlot,
  restartRemoteServices,
  migrateRemoteServiceContainers,
  ensureRemoteEgress,
  setRemoteProxyEgressEnabled,
} from '../../src/lib/cluster/remote-slot.mjs'
import { clusterGuardedEgressEnabled } from '../../src/lib/vm/proxy-exit-guard.mjs'

test('persisted cluster opt-in never bypasses guard validation or opens a raw route', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-guard-opt-in-'))
  const saved = process.env.KIN_CLUSTER_GUARDED_EGRESS
  delete process.env.KIN_CLUSTER_GUARDED_EGRESS
  t.after(() => {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
    if (saved === undefined) delete process.env.KIN_CLUSTER_GUARDED_EGRESS
    else process.env.KIN_CLUSTER_GUARDED_EGRESS = saved
  })
  const settings = new SettingsRepo(openDatabase({ dataDir: root }))
  assert.equal(clusterGuardedEgressEnabled(), false)
  settings.set('cluster_guarded_egress', 'true')
  assert.equal(clusterGuardedEgressEnabled(), false)
  settings.set('cluster_guarded_egress', true)
  assert.equal(clusterGuardedEgressEnabled(), true)
  process.env.KIN_CLUSTER_GUARDED_EGRESS = '0'
  assert.equal(clusterGuardedEgressEnabled(), false)
  delete process.env.KIN_CLUSTER_GUARDED_EGRESS
  settings.set('proxy_exit_guard', {
    required: true,
    proxies: { 'px-test': { expected_ip: '203.0.113.5', revision: 'test' } },
  })
  let forwards = 0
  const client = new (await import('node:events')).EventEmitter()
  client.forwardIn = () => {
    forwards++
  }
  await assert.rejects(
    ensureRemoteEgress(
      { client },
      { id: 'remote', node_id: 'node-test', proxy: { id: 'px-test', host: '127.0.0.1', port: 1080 } },
      { projectRoot: root },
    ),
    { reason: 'exit_guard_unverified' },
  )
  assert.equal(forwards, 0)
  client.emit('close')
})

test('strict guard rejects every remote activation entry before a node session is acquired', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-strict-'))
  try {
    const db = openDatabase({ dataDir: root })
    new SettingsRepo(db).set('proxy_exit_guard', { required: true, proxies: {} })
    const vm = { id: 'synthetic-remote', node_id: 'unconfigured', proxy: { id: 'px-test' } }
    for (const operation of [
      () => startRemoteSlot(vm, root),
      () => reloadRemoteSlot(vm, root),
      () => restartRemoteServices(vm, root),
      () => migrateRemoteServiceContainers(vm, root),
      () => ensureRemoteEgress({}, vm, {}),
      () => setRemoteProxyEgressEnabled(vm, root, true),
    ]) {
      const result = await operation()
      assert.equal(result.ok, false)
      assert.equal(result.code, 'exit_guard_unsupported_exit')
    }
    let invoked = false
    const result = await updateOneSlot(root, vm, {
      action: 'telemetry',
      telemetryFn: async () => {
        invoked = true
        return { ok: true }
      },
    })
    assert.equal(result.code, 'exit_guard_unsupported_exit')
    assert.equal(invoked, false)
  } finally {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('fleet service refresh cannot enable telemetry against the deployment kill switch', async () => {
  const previous = process.env.VM2API_DISABLE_TELEMETRY
  process.env.VM2API_DISABLE_TELEMETRY = '1'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-privacy-'))
  try {
    let received
    const result = await updateOneSlot(
      root,
      { id: 'synthetic-local', seed_policy: { telemetry_disabled: false } },
      {
        action: 'telemetry',
        telemetryEnabled: true,
        telemetryFn: async (options) => {
          received = options
          return { ok: true }
        },
      },
    )
    assert.equal(result.ok, true)
    assert.equal(received.enabled, false)
    assert.equal(received.telemetryEnabled, false)
  } finally {
    if (previous === undefined) delete process.env.VM2API_DISABLE_TELEMETRY
    else process.env.VM2API_DISABLE_TELEMETRY = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import {
  getProxyExitGuardConfig,
  getProxyExitGuardPolicy,
  evaluateProxyExitGuardState,
  getProxyExitGuardState,
  guardedProxyUrl,
  exitGuardConfigForProxy,
} from '../../src/lib/vm/proxy-exit-guard.mjs'
import { proxyBlockedReason } from '../../src/lib/vm/proxy-policy.mjs'

const policy = { required: true, expected_ip: '203.0.113.9', revision: 'operator-1' }
const now = Date.parse('2026-10-20T00:00:00Z')
const ready = {
  ...policy,
  observed_ip: policy.expected_ip,
  ready: true,
  latched: false,
  reason: 'verified',
  checked_at: new Date(now).toISOString(),
  socks_addr: '127.0.0.1:12345',
  pid: process.pid,
}

test('readiness requires current intent, matching observation, live helper and fresh private listener', () => {
  const evaluate = (state) => evaluateProxyExitGuardState(state, policy, { now, processActive: true })
  assert.equal(evaluate(ready).ready, true)
  for (const patch of [
    { revision: 'previous' },
    { expected_ip: '203.0.113.10' },
    { observed_ip: '203.0.113.10' },
    { latched: true },
    { ready: false },
    { checked_at: new Date(now - 30_001).toISOString() },
    { checked_at: new Date(now + 1).toISOString() },
    { socks_addr: '0.0.0.0:12345' },
    { socks_addr: '127.0.0.1:65536' },
  ])
    assert.equal(evaluate({ ...ready, ...patch }).ready, false, JSON.stringify(patch))
  assert.equal(evaluateProxyExitGuardState(ready, policy, { now, processActive: false }).ready, false)
  assert.equal(evaluate(null).ready, false)
})

test('startup checking has a bounded lifetime and cannot hide absent process or changed policy', () => {
  const state = { ...ready, ready: false, reason: 'exit_guard_checking' }
  assert.equal(evaluateProxyExitGuardState(state, policy, { now, processActive: true }).reason, 'exit_guard_checking')
  for (const options of [
    { now: now + 10_001, processActive: true },
    { now, processActive: false },
  ]) {
    assert.notEqual(evaluateProxyExitGuardState(state, policy, options).reason, 'exit_guard_checking')
  }
  assert.notEqual(
    evaluateProxyExitGuardState(state, { ...policy, revision: 'new' }, { now, processActive: true }).reason,
    'exit_guard_checking',
  )
})

test('operator policy persists separately from geo and malformed settings fail closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-guard-'))
  const db = openDatabase({ dataDir: root })
  try {
    const settings = new SettingsRepo(db)
    assert.equal(getProxyExitGuardConfig().required, false)
    settings.set('proxy_exit_guard', {
      required: true,
      proxies: { p1: { expected_ip: policy.expected_ip, revision: policy.revision } },
    })
    assert.deepEqual(getProxyExitGuardPolicy('p1'), policy)
    assert.equal(getProxyExitGuardState(root, 'p1').ready, false)
    assert.throws(
      () => guardedProxyUrl(root, { id: 'p1', host: '127.0.0.1', port: 1080, geo_ip: policy.expected_ip }),
      { code: 'exit_guard_blocked' },
    )
    assert.equal(
      proxyBlockedReason({ id: 'unconfigured', host: '127.0.0.1', port: 1080, geo_ip: policy.expected_ip }),
      'exit_ip_required',
    )
    assert.equal(proxyBlockedReason({ id: 'px-local', scheme: 'local' }), 'exit_guard_unsupported_exit')
    assert.throws(() => exitGuardConfigForProxy(root, { id: 'p1', node_id: 'remote' }), { code: 'exit_guard_blocked' })
    assert.throws(() => exitGuardConfigForProxy(root, { id: '../bad' }), { code: 'exit_guard_blocked' })
    db.prepare('UPDATE settings SET value=? WHERE key=?').run('{bad', 'proxy_exit_guard')
    assert.throws(() => getProxyExitGuardConfig(), { code: 'exit_guard_blocked' })
    settings.set('proxy_exit_guard', { required: false, proxies: {} })
    assert.equal(guardedProxyUrl(root, { host: '127.0.0.1', port: 1080 }), 'socks5h://127.0.0.1:1080')
  } finally {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('network pause preserves admission closure and requires a fresh live monitor', () => {
  const state = { ...ready, ready: false, observed_ip: '', reason: 'exit_guard_retrying' }
  const current = evaluateProxyExitGuardState(state, policy, { now: now + 25_000, processActive: true })
  assert.equal(current.reason, 'exit_guard_retrying')
  assert.equal(current.ready, false)
  assert.equal(current.latched, false)
  for (const options of [
    { now: now + 30_001, processActive: true },
    { now, processActive: false },
    { now: now - 1, processActive: true },
  ]) {
    assert.notEqual(evaluateProxyExitGuardState(state, policy, options).reason, 'exit_guard_retrying')
  }
  assert.notEqual(
    evaluateProxyExitGuardState({ ...state, latched: true }, policy, { now, processActive: true }).reason,
    'exit_guard_retrying',
  )
  assert.notEqual(
    evaluateProxyExitGuardState(state, { ...policy, revision: 'changed' }, { now, processActive: true }).reason,
    'exit_guard_retrying',
  )
})

test('raw helper startup cannot omit the required guard config', async () => {
  const { startEgressProcess } = await import('../../src/lib/vm/egress.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-guard-start-'))
  const db = openDatabase({ dataDir: root })
  try {
    new SettingsRepo(db).set('proxy_exit_guard', {
      required: true,
      proxies: { p1: { expected_ip: policy.expected_ip, revision: policy.revision } },
    })
    const result = await startEgressProcess({
      projectRoot: root,
      proxyId: 'p1',
      proxyUrl: 'socks5h://127.0.0.1:1',
      listenHost: '127.0.0.1',
      tcpPort: 20000,
      dnsPort: 20001,
      bin: fs.existsSync('/bin/true') ? '/bin/true' : '/usr/bin/true',
      exitGuard: null,
    })
    assert.equal(result.ok, true)
    const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8'))
    assert.equal(config.exit_guard.expected_ip, policy.expected_ip)
    assert.equal(config.exit_guard.revision, policy.revision)
    assert.match(config.exit_guard.state_path, /exit-guard-state.json$/)
  } finally {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('required mode rejects Codex startup before host kernel side effects', async () => {
  const { ensureSlotInferenceRuntime } = await import('../../src/lib/vm/slot-runtime.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-guard-codex-'))
  const db = openDatabase({ dataDir: root })
  try {
    new SettingsRepo(db).set('proxy_exit_guard', {
      required: true,
      proxies: { p1: { expected_ip: policy.expected_ip, revision: policy.revision } },
    })
    let writes = 0,
      starts = 0
    const result = await ensureSlotInferenceRuntime(
      { id: 'synthetic', platform: 'openai', proxy: { id: 'p1', host: '127.0.0.1', port: 1080 } },
      root,
      {
        ops: {
          writeCodexKernelConfig() {
            writes++
          },
          async ensureCodexKernel() {
            starts++
            return { ok: true }
          },
        },
      },
    )
    assert.equal(result.code, 'exit_guard_unsupported_platform')
    assert.equal(writes + starts, 0)
  } finally {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

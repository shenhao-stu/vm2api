import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { createProxyExitGuardManager, handleProxyExitGuard } from '../../src/lib/admin/proxy-exit-guard-manager.mjs'
import {
  getProxyExitGuardPolicy,
  guardedProxyUrl,
  exitGuardConfigForProxy,
} from '../../src/lib/vm/proxy-exit-guard.mjs'

function fixture(stop = { ok: true }) {
  const fixed = { expected_ip: '48.47.26.34', revision: 'fixed-before' }
  let config = { required: true, proxies: { fixed } }
  const effects = []
  const manager = createProxyExitGuardManager({
    settings: {
      get: () => structuredClone(config),
      set: (_key, value) => {
        config = value
      },
    },
    listProxies: () => [{ id: 'fixed' }, { id: 'dynamic' }],
    readState: () => ({ ready: false, latched: true, reason: 'exit_ip_required' }),
    quiesce: async (row) => {
      effects.push(['stop', row.id])
      return stop
    },
    startHelper: async (row) => {
      effects.push(['start', row.id])
      return { ok: true }
    },
    revision: () => 'changed-policy',
    notify: async () => ({ ok: true }),
    log() {},
  })
  return { manager, effects, config: () => config, fixed }
}

test('dynamic proxy is an explicit per-proxy opt-out; fixed and unknown proxies stay protected', async () => {
  const f = fixture()
  await f.manager.setExpected('dynamic', { required: false })
  assert.equal(f.config().required, true)
  assert.deepEqual(f.config().proxies.fixed, f.fixed)
  assert.equal(getProxyExitGuardPolicy('dynamic', f.config()).required, false)
  assert.equal(getProxyExitGuardPolicy('fixed', f.config()).required, true)
  assert.equal(getProxyExitGuardPolicy('unconfigured', f.config()).required, true)
  assert.equal(f.manager.policy('dynamic').required, false)
  assert.equal(f.config().proxies.dynamic.expected_ip, undefined)
  assert.deepEqual(f.effects, [['stop', 'dynamic']])
  await f.manager.poll()
  await f.manager.setExpected('dynamic', { required: false })
  assert.deepEqual(f.effects, [['stop', 'dynamic']], 'idempotent settings must not stop or start again')
})

test('stopping failure and malformed override never weaken existing policy', async () => {
  const f = fixture({ ok: false })
  await assert.rejects(f.manager.setExpected('dynamic', { required: false }), /stop_failed/)
  assert.equal(f.config().proxies.dynamic, undefined)
  for (const body of [
    { required: 'false' },
    { required: null },
    { required: 0 },
    { required: false, expected_ip: '48.47.26.34' },
  ]) {
    await assert.rejects(f.manager.setExpected('fixed', body), /invalid_config/)
  }
  assert.deepEqual(f.config().proxies.fixed, f.fixed)
  for (const required of ['false', null, 0]) {
    assert.throws(
      () => getProxyExitGuardPolicy('bad', { required: true, proxies: { bad: { required } } }),
      /config_invalid/,
    )
  }
})

test('rearm cannot disable a guard and restoring fixed-IP mode creates a fresh revision', async () => {
  const f = fixture()
  await assert.rejects(f.manager.setExpected('fixed', { required: false }, { rearm: true }), /invalid_config/)
  await f.manager.setExpected('dynamic', { required: false })
  await assert.rejects(
    f.manager.setExpected('dynamic', { expected_ip: '48.47.26.34' }, { rearm: true }),
    /expected_ip_changed/,
  )
  await f.manager.setExpected('dynamic', { expected_ip: '48.47.26.34' })
  assert.equal(f.manager.policy('dynamic').required, true)
  assert.equal(f.config().proxies.dynamic.expected_ip, '48.47.26.34')
  assert.deepEqual(f.effects, [
    ['stop', 'dynamic'],
    ['stop', 'dynamic'],
    ['start', 'dynamic'],
  ])
})

test('dynamic mode uses the native bound SOCKS URL without a fixed-IP helper or direct fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamic-guard-'))
  const db = openDatabase({ dataDir: root })
  try {
    new SettingsRepo(db).set('proxy_exit_guard', {
      required: true,
      proxies: { dynamic: { required: false, revision: 'operator-choice' } },
    })
    const proxy = { id: 'dynamic', scheme: 'socks5', host: '127.0.0.1', port: 11080 }
    assert.equal(exitGuardConfigForProxy(root, proxy), null)
    assert.equal(guardedProxyUrl(root, proxy), 'socks5h://127.0.0.1:11080')
    assert.throws(() => guardedProxyUrl(root, { ...proxy, id: 'other' }), { code: 'exit_guard_blocked' })
  } finally {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('per-proxy opt-out remains admin-only and validates before touching a proxy', async () => {
  const f = fixture()
  for (const role of ['user', 'admin']) {
    let response
    await handleProxyExitGuard({
      req: { method: 'PUT' },
      res: { setHeader() {} },
      url: new URL('http://localhost/api/panel/proxy-exit-guard/dynamic'),
      role,
      manager: f.manager,
      readBody: async () => ({ required: false }),
      json: (_res, status, body) => {
        response = { status, body }
      },
    })
    assert.equal(response.status, role === 'admin' ? 200 : 403)
  }
  assert.deepEqual(f.effects, [['stop', 'dynamic']])
})

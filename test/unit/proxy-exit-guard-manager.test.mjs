import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalExitIp,
  createProxyExitGuardManager,
  handleProxyExitGuard,
} from '../../src/lib/admin/proxy-exit-guard-manager.mjs'

function fixture(extra = {}) {
  let stored = { required: true, proxies: {} }
  let counter = 0
  const effects = []
  const state = { ready: false, latched: true, reason: 'exit_ip_mismatch', observed_ip: '203.0.113.2' }
  const manager = createProxyExitGuardManager({
    settings: {
      get: () => structuredClone(stored),
      set: (_k, value) => {
        effects.push('persist')
        stored = structuredClone(value)
      },
    },
    listProxies: () => [{ id: 'px-test' }, { id: 'px-local' }],
    readState: () => structuredClone(state),
    quiesce: async () => {
      effects.push('stop')
      return { ok: true }
    },
    startHelper: async () => {
      effects.push('helper')
      return { ok: true }
    },
    revision: () => String(++counter),
    log: () => effects.push('log'),
    notify: async () => {
      effects.push('notify')
    },
    ...extra,
  })
  return { manager, effects, state, stored: () => stored }
}

test('operator IP is explicit, canonical, and never populated by observed IP', async () => {
  const { manager, stored, effects } = fixture()
  await assert.rejects(manager.setExpected('px-test', { expected_ip: 'wrong' }), /invalid_ip/)
  assert.equal(stored().proxies['px-test'], undefined)
  await manager.setExpected('px-test', { expected_ip: '203.0.113.10' })
  assert.equal(stored().proxies['px-test'].expected_ip, '203.0.113.10')
  assert.deepEqual(effects.slice(0, 3), ['stop', 'persist', 'helper'])
  assert.equal(manager.view().proxies[0].state.latched, true)
  assert.equal(canonicalExitIp('2001:0db8::1'), '2001:db8::1')
})

test('same expected IP PUT is idempotent, rearm is explicit and cannot accept a new observation', async () => {
  const { manager, stored, effects } = fixture()
  await manager.setExpected('px-test', { expected_ip: '203.0.113.10' })
  const first = stored().proxies['px-test'].revision
  effects.length = 0
  await manager.setExpected('px-test', { expected_ip: '203.0.113.10' })
  assert.equal(stored().proxies['px-test'].revision, first)
  assert.deepEqual(effects, [])
  await assert.rejects(
    manager.setExpected('px-test', { expected_ip: '203.0.113.11' }, { rearm: true }),
    /expected_ip_changed/,
  )
  await manager.setExpected('px-test', { expected_ip: '203.0.113.10' }, { rearm: true })
  assert.notEqual(stored().proxies['px-test'].revision, first)
  assert.equal(stored().proxies['px-test'].expected_ip, '203.0.113.10')
  assert.ok(!effects.includes('resume'))
})

test('failure to stop prevents trust update; failed helper remains visibly blocked', async () => {
  const stopped = fixture({ quiesce: async () => ({ ok: false }) })
  await assert.rejects(stopped.manager.setExpected('px-test', { expected_ip: '203.0.113.10' }), /stop_failed/)
  assert.deepEqual(stopped.stored().proxies, {})
  const failed = fixture({ startHelper: async () => ({ ok: false }) })
  const result = await failed.manager.setExpected('px-test', { expected_ip: '203.0.113.10' })
  assert.equal(result.helpers[0].ok, false)
  assert.equal(result.proxies[0].state.ready, false)
})

test('health polls and notification failures cannot alter expected IP or unpause a slot', async () => {
  let clock = 0
  const { manager, stored, effects, state } = fixture({
    now: () => clock,
    notify: async () => {
      throw Error('secret')
    },
  })
  await manager.setExpected('px-test', { expected_ip: '203.0.113.10' })
  const before = structuredClone(stored())
  await manager.poll()
  clock = 300001
  state.reason = 'exit_probe_failed'
  await manager.poll()
  assert.deepEqual(stored(), before)
  assert.ok(!effects.includes('resume'))
})

test('unconfigured and unsupported direct proxies do not gain implicit trusted IPs', async () => {
  const { manager } = fixture()
  assert.equal(manager.view().proxies[0].expected_ip, null)
  await assert.rejects(manager.setExpected('px-local', { expected_ip: '203.0.113.10' }), /unsupported/)
  await assert.rejects(manager.setExpected('px-missing', { expected_ip: '203.0.113.10' }), /not_found/)
  await assert.rejects(manager.setRequired({ required: 'true' }), /invalid_config/)
  await assert.rejects(manager.setRequired({ required: true, proxies: {} }), /invalid_config/)
})

test('admin API rejects nonadmins before reading body or performing changes', async () => {
  let status
  await handleProxyExitGuard({
    req: { method: 'PUT' },
    res: { setHeader() {} },
    url: new URL('http://localhost/api/panel/proxy-exit-guard/px-test'),
    role: 'user',
    manager: {
      setExpected() {
        assert.fail('not authorized')
      },
    },
    readBody() {
      assert.fail('must not read body')
    },
    json: (_r, code) => {
      status = code
    },
  })
  assert.equal(status, 403)
})

test('admin rearm route requires exact stored intent and never exposes transport credentials', async () => {
  const { manager } = fixture()
  await manager.setExpected('px-test', { expected_ip: '203.0.113.10' })
  let result
  await handleProxyExitGuard({
    req: { method: 'POST' },
    res: { setHeader() {} },
    url: new URL('http://localhost/api/panel/proxy-exit-guard/px-test/rearm'),
    role: 'admin',
    manager,
    readBody: async () => ({ expected_ip: '203.0.113.11' }),
    json: (_r, code, body) => {
      result = { code, body }
    },
  })
  assert.equal(result.code, 409)
  assert.equal(result.body.error.code, 'exit_guard_expected_ip_changed')
  assert.doesNotMatch(JSON.stringify(result), /password|proxy_url/)
})

test('bound incident stops its slot, but a bounded startup probe is not killed', async () => {
  const stopped = []
  const { manager, state } = fixture({
    listProxies: () => [{ id: 'px-test', bound_vm_ids: ['slot-a'] }],
    onBlock: async (proxy, reason) => {
      stopped.push([proxy.id, reason])
      return { ok: true }
    },
  })
  state.latched = false
  state.reason = 'exit_guard_checking'
  await manager.poll()
  assert.deepEqual(stopped, [])
  state.latched = true
  state.reason = 'exit_ip_mismatch'
  await manager.poll()
  assert.deepEqual(stopped, [['px-test', 'exit_ip_mismatch']])
  await manager.poll()
  assert.equal(stopped.length, 1)
})

test('concurrent policy changes serialize intent writes without dropping another proxy', async () => {
  const { manager, stored } = fixture({ listProxies: () => [{ id: 'px-a' }, { id: 'px-b' }] })
  await Promise.all([
    manager.setExpected('px-a', { expected_ip: '203.0.113.10' }),
    manager.setExpected('px-b', { expected_ip: '198.51.100.20' }),
  ])
  assert.deepEqual(Object.keys(stored().proxies).sort(), ['px-a', 'px-b'])
})

test('invalid persisted policy fails closed instead of resetting enforcement to false', () => {
  const { manager } = fixture({ settings: { has: () => true, get: () => null } })
  assert.throws(() => manager.view(), /config_invalid/)
})

test('native notification false result is reported without leaking provider error data', async () => {
  const logs = []
  const { manager } = fixture({
    log: (text) => logs.push(text),
    notify: async () => ({ ok: false, results: [{ error: 'private-webhook' }] }),
  })
  await manager.setExpected('px-test', { expected_ip: '203.0.113.10' })
  assert.ok(logs.some((text) => text.includes('external_notification_failed')))
  assert.ok(logs.every((text) => !text.includes('private-webhook')))
})

test('notification latency cannot make an old poll stop a newly rearmed helper', async () => {
  let stored = {
    required: true,
    proxies: {
      'px-a': { expected_ip: '203.0.113.10', revision: 'old-a' },
      'px-b': { expected_ip: '203.0.113.11', revision: 'old-b' },
    },
  }
  const states = new Map(
    ['px-a', 'px-b'].map((id) => [id, { ready: false, latched: true, reason: 'exit_ip_mismatch' }]),
  )
  const calls = []
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const manager = createProxyExitGuardManager({
    settings: {
      get: () => structuredClone(stored),
      set: (_key, value) => {
        stored = structuredClone(value)
      },
    },
    listProxies: () => ['px-a', 'px-b'].map((id) => ({ id, bound_vm_ids: ['slot-' + id] })),
    readState: (id) => states.get(id),
    quiesce: async () => ({ ok: true }),
    startHelper: async ({ id }) => {
      states.set(id, { ready: true })
      return { ok: true }
    },
    onBlock: async ({ id }) => {
      calls.push([id, stored.proxies[id].revision])
      return { ok: true }
    },
    revision: () => 'new-b',
    log() {},
    notify: async () => {
      entered.resolve()
      await release.promise
      return { ok: true }
    },
  })
  const poll = manager.poll()
  await entered.promise
  await manager.setExpected('px-b', { expected_ip: '203.0.113.11' }, { rearm: true })
  release.resolve()
  await poll
  assert.ok(!calls.some(([id, rev]) => id === 'px-b' && rev === 'new-b'))
  assert.equal(states.get('px-b').ready, true)
})

test('failed native stop retries next poll independently of notification cooldown', async () => {
  let stops = 0
  let alerts = 0
  const { manager } = fixture({
    listProxies: () => [{ id: 'px-test', bound_vm_ids: ['slot-a'] }],
    onBlock: async () => {
      stops++
      return { ok: false }
    },
    notify: async () => {
      alerts++
      return { ok: true }
    },
  })
  await manager.poll()
  await manager.poll()
  assert.equal(stops, 2)
  assert.equal(alerts, 1)
})

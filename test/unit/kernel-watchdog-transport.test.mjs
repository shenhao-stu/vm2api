import assert from 'node:assert/strict'
import test from 'node:test'
import { createKernelWatchdog } from '../../src/lib/transport/kernel-watchdog.mjs'
import { kernelFaults } from '../../src/lib/transport/rust-kernel-client.mjs'

let sequence = 0
function fixture({ remote = true, health, state = 'running', status = 'running', observe } = {}) {
  const id = `transport-watchdog-${++sequence}`
  const vm = { id, status, runtime: { type: 'docker' }, ...(remote ? { node_id: 'node-fixture' } : {}) }
  let at = 0
  let current = health
  const actions = []
  const wd = createKernelWatchdog({
    config: { restart_backoff_sec: [10], restart_window_sec: 3600 },
    listTargets: () => [vm],
    probeVm: (v) => v,
    health: async () => current,
    observeRuntime: observe || (async () => ({ state })),
    ensure: async () => {
      actions.push('ensure')
      return { ok: true }
    },
    revive: async () => {
      actions.push('revive')
      return { ok: true }
    },
    now: () => at,
  })
  return {
    id,
    wd,
    actions,
    setHealth: (value) => {
      current = value
    },
    async tick(time) {
      at = time
      await wd.tick()
    },
  }
}

for (const health of [
  null,
  { ok: false, code: 'worker_timeout', error: 'worker timeout' },
  { ok: false, code: 'ECONNRESET' },
  { ok: false, code: 'EPIPE' },
  { ok: false, code: 'ECONNREFUSED' },
  { ok: false, status: 503 },
]) {
  test(`remote running container is not a dead kernel when health is ${JSON.stringify(health)}`, async () => {
    const f = fixture({ health })
    try {
      for (const at of [0, 10_000, 30_000, 1_000_000]) await f.tick(at)
      assert.deepEqual(f.actions, [])
      assert.equal(f.wd.restartsInWindow(f.id), 0)
      assert.equal(kernelFaults.has(f.id), false)
    } finally {
      f.wd.reset(f.id)
    }
  })
}

test('remote transport loss does not spend the later authoritative unhealthy recovery budget', async () => {
  const f = fixture({ health: { ok: false, code: 'worker_timeout' } })
  try {
    for (const at of [0, 10_000, 30_000]) await f.tick(at)
    assert.deepEqual(f.actions, [])
    f.setHealth({ status: 200, engine: 'rust', healthy: false, unhealthy_reason: 'cli_restarts_exhausted' })
    await f.tick(40_000)
    assert.deepEqual(f.actions, [])
    await f.tick(50_000)
    assert.deepEqual(f.actions, ['ensure'])
    await f.tick(80_000)
    assert.equal(kernelFaults.has(f.id), true)
  } finally {
    f.wd.reset(f.id)
  }
})

test('remote healthy reply after transport recovery needs no restart or fault reset', async () => {
  const f = fixture({ health: { ok: false, code: 'EPIPE' } })
  try {
    for (const at of [0, 10_000]) await f.tick(at)
    f.setHealth({ ok: true, engine: 'rust', healthy: true, ready_slots: 1 })
    await f.tick(40_000)
    assert.deepEqual(f.actions, [])
    assert.equal(f.wd.restartsInWindow(f.id), 0)
    assert.equal(kernelFaults.has(f.id), false)
  } finally {
    f.wd.reset(f.id)
  }
})

for (const state of ['missing', 'stopped', 'restarting']) {
  test(`confirmed remote container ${state} still receives bounded recovery`, async () => {
    const f = fixture({ health: null, state })
    try {
      await f.tick(0)
      await f.tick(10_000)
      assert.deepEqual(f.actions, ['revive'])
      assert.equal(f.wd.restartsInWindow(f.id), 1)
    } finally {
      f.wd.reset(f.id)
    }
  })
}

for (const status of ['disabled', 'stopped']) {
  test(`remote ${status} intent is preserved despite a missing runtime`, async () => {
    const f = fixture({ health: null, state: 'missing', status })
    try {
      await f.tick(0)
      await f.tick(10_000)
      assert.deepEqual(f.actions, [])
    } finally {
      f.wd.reset(f.id)
    }
  })
}

test('local dead-kernel recovery is unchanged', async () => {
  const f = fixture({ health: null, remote: false })
  try {
    await f.tick(0)
    await f.tick(10_000)
    assert.deepEqual(f.actions, ['ensure'])
  } finally {
    f.wd.reset(f.id)
  }
})

test('operator hold acquired during remote observation blocks revival and recovery accounting', async () => {
  let observed
  const f = fixture({
    health: null,
    observe: () =>
      new Promise((resolve) => {
        observed = resolve
      }),
  })
  try {
    const tick = f.tick(0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(typeof observed, 'function', 'runtime must be observed after the first lost health reply')
    const held = f.wd.hold(f.id)
    observed({ state: 'missing' })
    await Promise.all([tick, held])
    await f.tick(10_000)
    assert.deepEqual(f.actions, [])
    assert.equal(f.wd.restartsInWindow(f.id), 0)
    assert.equal(kernelFaults.has(f.id), false)
  } finally {
    f.wd.release(f.id)
    f.wd.reset(f.id)
  }
})

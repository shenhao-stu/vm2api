import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import * as router from '../../src/lib/transport/kernel-router.mjs'
import { rustKernelHealth } from '../../src/lib/transport/rust-kernel-client.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'

// The unpatched provider gives a behavioral red: admission + dispatch issue two GETs.
const probe = router.probeRustHealth || rustKernelHealth
let sequence = 0

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-health-reuse-'))
  const id = `vm-health-${++sequence}`
  const homeDir = path.join(root, 'vms', id, 'cli-home')
  const runDir = path.join(root, 'vms', id, 'run')
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'internal.token'), 'fixture-token')
  const socket = path.join(runDir, 'kernel.sock')
  const state = {
    healthCalls: 0,
    messageCalls: 0,
    health: {
      ok: true,
      vm_id: id,
      engine: 'rust',
      healthy: true,
      ready_slots: 20,
      cli_pid: 14,
    },
    onHealth: null,
  }
  const server = http.createServer((req, res) => {
    assert.equal(req.headers['x-kin-internal-token'], 'fixture-token')
    if (req.url === '/internal/health') {
      state.healthCalls++
      if (state.onHealth?.(req, res) === false) return
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(state.health))
      return
    }
    assert.equal(req.url, '/internal/v1/messages')
    state.messageCalls++
    req.resume()
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-terminal-state': 'verified',
    })
    res.end(
      JSON.stringify({
        id: 'fixture-message',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'fixture' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    )
  })
  await new Promise((resolve) => server.listen(socket, resolve))
  const vm = {
    id,
    name: id,
    status: 'running',
    schedulable: true,
    inference_engine: 'rust',
    proxy_cli_enabled: true,
    proxy: { id: `proxy-${id}`, url: 'socks5h://127.0.0.1:10001' },
    policy: {
      maxConcurrency: 1,
      concurrencyOverride: true,
      priority: 0,
      weight: 1,
    },
    runtime: { kernel_socket: socket, worker_run_dir: runDir },
    claude: {
      account_uuid: `account-${id}`,
      account_tier: 'pro',
      access_token: 'fixture-access',
      refresh_token: 'fixture-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
  }
  fs.writeFileSync(path.join(root, 'vms', `${id}.json`), JSON.stringify(vm))
  const exec = { vmId: id, homeDir, vm }
  const prevBin = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = '/bin/true'
  const pool = new PoolScheduler({
    projectRoot: root,
    workerHealth: probe,
    accountQuota: { canAccept: () => ({ ok: true }) },
  })
  t.after(async () => {
    for (const timer of pool.cooldownTimers.values()) clearTimeout(timer)
    router.clearRustHealthCache(id)
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
    if (prevBin == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = prevBin
  })
  const dispatch = (routing = {}) =>
    router.dispatchCallInference({
      exec,
      routing,
      body: {
        model: 'claude-test',
        messages: [{ role: 'user', content: 'fixture' }],
      },
      timeoutMs: 1000,
    })
  return { root, exec, state, pool, dispatch }
}

test('fresh scheduler health eliminates the duplicate dispatch GET', async (t) => {
  const f = await fixture(t)
  const first = await f.pool.selectAndReserve({
    model: 'claude-test',
    allowWait: false,
  })
  assert.equal(first.ok, true)
  try {
    assert.equal((await f.dispatch()).ok, true)
    assert.equal(f.state.healthCalls, 1)
    assert.equal(f.state.messageCalls, 1)
  } finally {
    first.release()
  }
})

test('the scheduler 5s cache cannot renew the hop 2s cache', async (t) => {
  const f = await fixture(t)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  await f.pool.getWorkerHealth(f.exec)
  t.mock.timers.tick(2001)
  await f.pool.getWorkerHealth(f.exec)
  assert.equal(f.state.healthCalls, 1)
  assert.equal(router.peekRustHealth(f.exec, 2000), null)
  assert.equal((await f.dispatch()).ok, true)
  assert.equal(f.state.healthCalls, 2)
})

test('probe round-trip time counts toward freshness', async (t) => {
  const f = await fixture(t)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  f.state.onHealth = () => t.mock.timers.tick(2001)
  await probe(f.exec)
  assert.equal(router.peekRustHealth(f.exec, 2000), null)
})

test('a larger configured TTL cannot extend the shared admission observation', async (t) => {
  const f = await fixture(t)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  await probe(f.exec)
  t.mock.timers.tick(2001)
  assert.equal((await f.dispatch({ inference: { health_ttl_ms: 10_000 } })).ok, true)
  assert.equal(f.state.healthCalls, 2)
})

test('a different VM health response is not reused for either VM', async (t) => {
  const f = await fixture(t)
  f.state.health.vm_id = 'other-vm'
  await probe(f.exec)
  assert.equal(router.peekRustHealth(f.exec, 2000), null)
  assert.equal(router.peekRustHealth({ vmId: 'other-vm' }, 2000), null)
})

test('health without a VM identity is not shared', async (t) => {
  const f = await fixture(t)
  delete f.state.health.vm_id
  await probe(f.exec)
  assert.equal(router.peekRustHealth(f.exec, 2000), null)
})

test('a clock rollback does not extend health freshness', async (t) => {
  const f = await fixture(t)
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now })
  await probe(f.exec)
  assert.equal(router.peekRustHealth(f.exec, 2000, now - 1), null)
})

for (const [name, update] of [
  ['unhealthy', { healthy: false }],
  ['busy', { ready_slots: 0 }],
  ['failed', { ok: false }],
]) {
  test(`${name} probe invalidates an earlier successful observation`, async (t) => {
    const f = await fixture(t)
    router.rememberRustHealth(f.exec, {
      ok: true,
      health: { ...f.state.health },
    })
    Object.assign(f.state.health, update)
    await probe(f.exec)
    assert.equal(router.peekRustHealth(f.exec, 2000), null)
  })
}

test('a transport failure cannot retain previously cached success', async (t) => {
  const f = await fixture(t)
  router.rememberRustHealth(f.exec, {
    ok: true,
    health: { ...f.state.health },
  })
  f.state.onHealth = (req) => {
    req.socket.destroy()
    return false
  }
  const result = await probe(f.exec)
  assert.equal(result.ok, false)
  assert.equal(router.peekRustHealth(f.exec, 2000), null)
})

test('disabled native hop cache still performs its own probe', async (t) => {
  const f = await fixture(t)
  await probe(f.exec)
  assert.equal((await f.dispatch({ inference: { health_ttl_ms: 0 } })).ok, true)
  assert.equal(f.state.healthCalls, 2)
})

test('fresh health cannot bypass the per-account concurrency 1 reservation', async (t) => {
  const f = await fixture(t)
  const args = { model: 'claude-test', allowWait: false }
  const first = await f.pool.selectAndReserve(args)
  assert.equal(first.ok, true)
  try {
    const second = await f.pool.selectAndReserve(args)
    assert.equal(second.ok, false)
    assert.equal(second.reason, 'all_accounts_busy')
    assert.equal(f.state.messageCalls, 0)
  } finally {
    first.release()
  }
  const resumed = await f.pool.selectAndReserve(args)
  assert.equal(resumed.ok, true)
  resumed.release()
})

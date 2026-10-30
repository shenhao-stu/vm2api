import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { dispatchCallInference, waitForReadySlot } from '../../src/lib/transport/kernel-router.mjs'
import { diagnoseSlotServices } from '../../src/lib/vm/slot-recovery.mjs'

async function fixture(t, { remote = true, delay = 1100, healthy = true, respond = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'))
  const socket = path.join(root, 'kernel.sock')
  const timers = new Set()
  const calls = { health: 0, inference: 0 }
  const server = http.createServer((req, res) => {
    if (req.url === '/internal/health') {
      calls.health++
      if (!respond) return
      const timer = setTimeout(() => {
        timers.delete(timer)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, healthy, ready_slots: 1, cli_pid: 42 }))
      }, delay)
      timers.add(timer)
      return
    }
    calls.inference++
    res.writeHead(200, { 'content-type': 'application/json', 'x-terminal-state': 'verified' })
    res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'fixture' }] }))
  })
  await new Promise((resolve) => server.listen(socket, resolve))
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer)
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const exec = {
    vmId: root,
    vm: { id: root, ...(remote ? { node_id: 'fixture-node' } : {}), runtime: { kernel_socket: socket } },
  }
  const send = () =>
    dispatchCallInference({
      exec,
      body: { model: 'fixture', messages: [{ role: 'user', content: 'fixture' }] },
      routing: { inference: { health_ttl_ms: 0 } },
      timeoutMs: 5000,
    })
  return { root, exec, calls, send }
}

test('remote health over 800ms reaches inference once without a false unavailable', async (t) => {
  const fx = await fixture(t)
  const result = await fx.send()
  assert.equal(result.status, 200)
  assert.equal(result.ok, true)
  assert.equal(fx.calls.inference, 1)
})

test('local health retains its short deadline and does not call inference', async (t) => {
  const previous = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = '/bin/true'
  t.after(() => {
    if (previous == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previous
  })
  const fx = await fixture(t, { remote: false })
  const start = performance.now()
  const result = await fx.send()
  assert.equal(result.status, 503)
  assert.equal(fx.calls.inference, 0)
  assert.ok(performance.now() - start < 1050)
})

test('a remote unhealthy kernel is still rejected without inference', async (t) => {
  const fx = await fixture(t, { healthy: false, delay: 20 })
  const result = await fx.send()
  assert.equal(result.status, 503)
  assert.equal(fx.calls.inference, 0)
})

test('remote slot polling tolerates node latency within its existing wait budget', async (t) => {
  const fx = await fixture(t)
  const result = await waitForReadySlot(fx.exec, 1800, 50)
  assert.equal(result.ok, true)
  assert.equal(fx.calls.inference, 0)
})

test('remote slot polling does not extend an exhausted wait budget', async (t) => {
  const fx = await fixture(t, { respond: false })
  const start = performance.now()
  const result = await waitForReadySlot(fx.exec, 180, 40)
  assert.equal(result.ok, false)
  assert.equal(fx.calls.inference, 0)
  assert.ok(performance.now() - start < 350)
})

test('remote panel diagnosis uses the same node health budget', async (t) => {
  const fx = await fixture(t, { delay: 1800 })
  const vm = { ...fx.exec.vm, status: 'running', claude: { has_access: true, has_refresh: true } }
  const result = await diagnoseSlotServices(vm, {
    projectRoot: fx.root,
    probes: { container: async () => ({ exists: true, running: true }), cluster: () => null },
  })
  assert.equal(result.checks.find((c) => c.id === 'kernel').status, 'ok')
  assert.equal(fx.calls.inference, 0)
})

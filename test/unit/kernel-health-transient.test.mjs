import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { probeRustHealth, dispatchCallInference, clearRustHealthCache } from '../../src/lib/transport/kernel-router.mjs'

async function fixture(t, onHealth) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-recheck-'))
  const socket = path.join(root, 'k.sock')
  const timers = new Set()
  let healthCalls = 0,
    inferenceCalls = 0
  const server = http.createServer((req, res) => {
    if (req.url === '/internal/health') {
      healthCalls++
      onHealth({
        req,
        res,
        count: healthCalls,
        reply(delay = 0, body = {}) {
          const timer = setTimeout(() => {
            timers.delete(timer)
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true, vm_id: root, healthy: true, ready_slots: 1, cli_pid: 42, ...body }))
          }, delay)
          timers.add(timer)
        },
      })
      return
    }
    inferenceCalls++
    res.writeHead(200, { 'content-type': 'application/json', 'x-terminal-state': 'verified' })
    res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'fixture' }] }))
  })
  await new Promise((resolve) => server.listen(socket, resolve))
  const exec = { vmId: root, vm: { id: root, node_id: 'fixture-node', runtime: { kernel_socket: socket } } }
  t.after(async () => {
    clearRustHealthCache(root)
    for (const timer of timers) clearTimeout(timer)
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    exec,
    counts: () => ({ healthCalls, inferenceCalls }),
    send: (opts = {}) =>
      dispatchCallInference({
        exec,
        body: { model: 'fixture', messages: [{ role: 'user', content: 'fixture' }] },
        timeoutMs: 10000,
        ...opts,
      }),
  }
}

test('remote health delayed beyond 3s fits the widened probe window without replaying inference', async (t) => {
  const f = await fixture(t, ({ reply }) => reply(3150))
  const result = await f.send()
  assert.equal(result.status, 200)
  assert.deepEqual(f.counts(), { healthCalls: 1, inferenceCalls: 1 })
})

test('remote reset permits exactly one read-only recheck', async (t) => {
  const f = await fixture(t, ({ req, reply, count }) => (count === 1 ? req.socket.destroy() : reply()))
  assert.equal((await f.send()).status, 200)
  assert.deepEqual(f.counts(), { healthCalls: 2, inferenceCalls: 1 })
})

test('persistent transport failure is bounded and does not claim the kernel died', async (t) => {
  const f = await fixture(t, ({ req }) => req.socket.destroy())
  const result = await f.send()
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'kernel_unavailable')
  assert.match(result.body.error.message, /health probe/)
  assert.doesNotMatch(result.body.error.message, /is down|watchdog recovery/)
  assert.equal(result.upstreamExecutions, 0)
  assert.deepEqual(f.counts(), { healthCalls: 2, inferenceCalls: 0 })
})

test('cancelled health probe cannot dispatch or recheck', async (t) => {
  const controller = new AbortController()
  const f = await fixture(t, () => controller.abort())
  const result = await f.send({ signal: controller.signal })
  assert.equal(result.status, 499)
  assert.deepEqual(f.counts(), { healthCalls: 1, inferenceCalls: 0 })
})

test('authoritative unhealthy reply is not retried', async (t) => {
  const f = await fixture(t, ({ reply }) => reply(0, { healthy: false, unhealthy_reason: 'cli_restarts_exhausted' }))
  assert.equal((await f.send()).status, 503)
  assert.deepEqual(f.counts(), { healthCalls: 1, inferenceCalls: 0 })
})

test('health authentication rejection is not retried', async (t) => {
  const f = await fixture(t, ({ res }) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end('{"ok":false}')
  })
  assert.equal((await f.send()).status, 503)
  assert.deepEqual(f.counts(), { healthCalls: 1, inferenceCalls: 0 })
})

test('a read-only recheck respects the remaining request budget', async (t) => {
  const f = await fixture(t, () => {})
  const start = performance.now()
  const result = await probeRustHealth(f.exec, { timeoutMs: 30, remainingBudgetMs: 90 })
  assert.equal(result.ok, false)
  assert.deepEqual(f.counts(), { healthCalls: 2, inferenceCalls: 0 })
  assert.ok(performance.now() - start < 230)
})

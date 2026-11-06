import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import {
  codexKernelTracked,
  ensureCodexKernel,
  finishCodexRecycle,
  invalidateCodexKernelHealth,
  stopCodexKernel,
  stopCodexKernelAndWait,
  stopAllCodexKernelsAndWait,
  writeCodexKernelConfig,
} from '../../src/lib/transport/codex-kernel-supervisor.mjs'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check) {
  const deadline = Date.now() + 2000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'local fake kernel condition timed out')
    await pause(5)
  }
}

function fixture(t) {
  // Unix socket paths must fit macOS's short sockaddr_un limit.
  const root = fs.mkdtempSync('/tmp/ck-warm-')
  const bin = path.join(root, 'kernel')
  const control = path.join(root, 'control.json')
  const probes = path.join(root, 'probes.jsonl')
  fs.writeFileSync(control, '{}')
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs')
const http = require('node:http')
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const server = http.createServer((_req, res) => {
  const options = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8'))
  fs.appendFileSync(${JSON.stringify(probes)}, JSON.stringify({ pid: process.pid }) + '\\n')
  if (options.hang) return
  const respond = () => {
    res.statusCode = options.status || 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: options.ok ?? res.statusCode === 200, pid: process.pid }))
  }
  if (options.delayMs) setTimeout(respond, options.delayMs)
  else respond()
})
server.listen(config.socket_path)
process.on('SIGTERM', () => {
  const options = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8'))
  setTimeout(() => {
    server.closeAllConnections()
    server.close(() => process.exit(0))
  }, options.termDelayMs || 0)
})
`,
    { mode: 0o755 },
  )
  const previousBin = process.env.KIN_CODEX_KERNEL_BIN
  process.env.KIN_CODEX_KERNEL_BIN = bin
  const vm = { id: 'vm-warm', platform: 'openai', proxy: { url: 'socks5h://127.0.0.1:1080' } }
  const exec = { vmId: vm.id, vm, homeDir: path.join(root, 'vms', vm.id, 'cli-home') }
  const paths = writeCodexKernelConfig(root, vm)
  const servers = []
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    const child = stopCodexKernel(vm.id)
    if (child) await finishCodexRecycle(child)
    if (previousBin === undefined) delete process.env.KIN_CODEX_KERNEL_BIN
    else process.env.KIN_CODEX_KERNEL_BIN = previousBin
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    bin,
    exec,
    paths,
    control(options) {
      fs.writeFileSync(control, JSON.stringify(options))
    },
    count() {
      return fs.existsSync(probes) ? fs.readFileSync(probes, 'utf8').trim().split('\n').filter(Boolean).length : 0
    },
    async ensure(options = {}) {
      return ensureCodexKernel(exec, { timeoutMs: 8000, ...options })
    },
    async ready() {
      const result = await this.ensure()
      assert.equal(result.ok, true, JSON.stringify(result))
      return result
    },
    async listener(handler) {
      const server = http.createServer(handler)
      servers.push(server)
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(paths.socketPath, resolve)
      })
    },
  }
}

test('tracked live kernels reuse short healthy answers; zero disables reuse and expiry re-probes', async (t) => {
  const f = fixture(t)
  const first = await f.ready()
  const count = f.count()
  const cached = await f.ensure()
  assert.equal(cached.cached, true)
  assert.equal(cached.health.pid, first.health.pid)
  assert.equal(f.count(), count)
  assert.equal((await f.ensure({ healthTtlMs: 0 })).cached, undefined)
  assert.equal(f.count(), count + 1)
  await pause(15)
  assert.equal((await f.ensure({ healthTtlMs: 10 })).cached, undefined)
  assert.equal(f.count(), count + 2)
})

test('owner shutdown retains detached children until their actual graceful exit', async (t) => {
  const f = fixture(t)
  await f.ready()
  f.control({ termDelayMs: 120 })
  let finished = false
  const pending = stopAllCodexKernelsAndWait().then(() => {
    finished = true
  })
  await pause(25)
  assert.equal(finished, false)
  assert.equal(codexKernelTracked(f.exec.vmId), true)
  await pending
  assert.equal(codexKernelTracked(f.exec.vmId), false)
})

test('config and token replacements invalidate a healthy answer', async (t) => {
  const f = fixture(t)
  await f.ready()
  for (const file of [f.paths.configPath, f.paths.tokenPath]) {
    const count = f.count()
    const value = fs.readFileSync(file)
    fs.writeFileSync(`${file}.next`, value)
    fs.renameSync(`${file}.next`, file)
    const next = await f.ensure()
    assert.equal(next.ok, true)
    assert.equal(next.cached, undefined)
    assert.equal(f.count(), count + 1)
  }
})

test('a config changed during a probe is not blessed by its old response', async (t) => {
  const f = fixture(t)
  await f.ready()
  const count = f.count()
  f.control({ delayMs: 80 })
  const pending = f.ensure({ healthTtlMs: 0 })
  await until(() => f.count() === count + 1)
  const config = JSON.parse(fs.readFileSync(f.paths.configPath, 'utf8'))
  fs.writeFileSync(f.paths.configPath, JSON.stringify({ ...config, fixture_revision: 2 }))
  assert.equal((await pending).ok, true)
  f.control({})
  assert.equal((await f.ensure()).cached, undefined)
  assert.equal(f.count(), count + 2)
})

test('socket replacement invalidates health even while the tracked child remains alive', async (t) => {
  const f = fixture(t)
  await f.ready()
  const oldInode = fs.statSync(f.paths.socketPath).ino
  fs.unlinkSync(f.paths.socketPath)
  let probes = 0
  await f.listener((_req, res) => {
    probes += 1
    res.end(JSON.stringify({ ok: true, replacement: true }))
  })
  assert.notEqual(fs.statSync(f.paths.socketPath).ino, oldInode)
  assert.equal(codexKernelTracked(f.exec.vmId), true)
  const result = await f.ensure()
  assert.equal(result.cached, undefined)
  assert.equal(result.health.replacement, true)
  assert.equal(probes, 1)
})

test('untracked listeners are probed on every call and never cached', async (t) => {
  const f = fixture(t)
  let probes = 0
  await f.listener((_req, res) => {
    probes += 1
    res.end(JSON.stringify({ ok: true }))
  })
  assert.equal(codexKernelTracked(f.exec.vmId), false)
  assert.equal((await f.ensure()).ok, true)
  assert.equal((await f.ensure()).cached, undefined)
  assert.equal(probes, 2)
})

test('concurrent callers share one live health probe', async (t) => {
  const f = fixture(t)
  await f.ready()
  f.control({ delayMs: 80 })
  const count = f.count()
  const results = await Promise.all(Array.from({ length: 8 }, () => f.ensure({ healthTtlMs: 0 })))
  assert.ok(results.every((result) => result.ok))
  assert.equal(f.count(), count + 1)
})

test('a timed-out probe clears a prior healthy cache entry', async (t) => {
  const f = fixture(t)
  await f.ready()
  f.control({ hang: true })
  const failed = await f.ensure({ healthTtlMs: 0, timeoutMs: 200 })
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'health_timeout')
  const count = f.count()
  f.control({})
  const recovered = await f.ensure()
  assert.equal(recovered.ok, true)
  assert.equal(recovered.cached, undefined)
  assert.ok(f.count() > count)
})

test('child exit invalidates cached health and a new ensure starts a different child', async (t) => {
  const f = fixture(t)
  const first = await f.ready()
  process.kill(first.health.pid, 'SIGKILL')
  await until(() => !codexKernelTracked(f.exec.vmId))
  const next = await f.ensure()
  assert.equal(next.ok, true)
  assert.equal(next.cached, undefined)
  assert.notEqual(next.health.pid, first.health.pid)
})

test('explicit stop invalidates cached health before starting a replacement', async (t) => {
  const f = fixture(t)
  const first = await f.ready()
  const stopping = stopCodexKernelAndWait(f.exec)
  const pending = f.ensure()
  assert.equal((await stopping).ok, true)
  const next = await pending
  assert.equal(next.ok, true)
  assert.equal(next.cached, undefined)
  assert.notEqual(next.health.pid, first.health.pid)
})

test('spawn errors are not reported as a tracked living child', async (t) => {
  const f = fixture(t)
  fs.writeFileSync(f.bin, '#!/nonexistent/kin-fake-interpreter\n')
  const failed = await f.ensure({ timeoutMs: 200 })
  assert.equal(failed.ok, false)
  assert.equal(codexKernelTracked(f.exec.vmId), false)
})

test('explicit health invalidation re-probes without replacing the child', async (t) => {
  const f = fixture(t)
  const first = await f.ready()
  const count = f.count()
  invalidateCodexKernelHealth(f.exec.vmId)
  const next = await f.ensure()
  assert.equal(next.ok, true)
  assert.equal(next.cached, undefined)
  assert.equal(next.health.pid, first.health.pid)
  assert.equal(f.count(), count + 1)
})

test('HTTP 200 with an explicitly unhealthy body is never cached', async (t) => {
  const f = fixture(t)
  await f.ready()
  f.control({ ok: false })
  await f.ensure({ healthTtlMs: 0 })
  const count = f.count()
  const next = await f.ensure()
  assert.equal(next.cached, undefined)
  assert.equal(f.count(), count + 1)
})

test('invalidation during a probe prevents its old response from repopulating the cache', async (t) => {
  const f = fixture(t)
  await f.ready()
  const count = f.count()
  f.control({ delayMs: 80 })
  const pending = f.ensure({ healthTtlMs: 0 })
  await until(() => f.count() === count + 1)
  invalidateCodexKernelHealth(f.exec.vmId)
  assert.equal((await pending).ok, true)
  f.control({})
  assert.equal((await f.ensure()).cached, undefined)
  assert.equal(f.count(), count + 2)
})

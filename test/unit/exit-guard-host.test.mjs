import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { resolveImportProxy } from '../../src/lib/vm/proxy-resolve.mjs'
import { createImportCommit } from '../../src/lib/oauth/import-commit.mjs'
import { forwardApi } from '../../src/lib/transport/api-kernel-client.mjs'
import { ensureCodexKernel, writeCodexKernelConfig } from '../../src/lib/transport/codex-kernel-supervisor.mjs'
import { hostProxyUrlForVm } from '../../src/lib/vm/slot-host.mjs'

const proxy = { id: 'px-fixture', host: '127.0.0.1', port: 19080, url: 'socks5h://127.0.0.1:19080' }
const vm = { id: 'vm-fixture', proxy }
const proxyPool = {
  snapshot: () => ({ proxies: [{ ...proxy, enabled: true, status: 'ok' }] }),
  getProxyForVm: () => proxy,
}

function requireExitGuard(t) {
  const settings = new SettingsRepo(openDatabase({ dbPath: ':memory:' }))
  settings.set('proxy_exit_guard', { required: true, proxies: {} })
  t.after(closeDatabase)
  return settings
}

test('required exit guard rejects OAuth proxy override before returning any route', (t) => {
  requireExitGuard(t)
  const resolved = resolveImportProxy({ vm, proxyPool, overrideUrl: 'socks5h://other.invalid:1080' })
  assert.equal(resolved.ok, false)
  assert.equal(resolved.reason, 'exit_guard_override_forbidden')
  assert.equal(resolved.proxyUrl, null)
})

test('required exit guard rejects Codex host routes as unsupported', (t) => {
  requireExitGuard(t)
  const resolved = resolveImportProxy({ vm: { ...vm, platform: 'openai' }, proxyPool })
  assert.equal(resolved.ok, false)
  assert.equal(resolved.reason, 'exit_guard_unsupported_platform')
})

test('required exit guard rejects remote nodes and local direct exits', (t) => {
  requireExitGuard(t)
  const remote = resolveImportProxy({ vm: { ...vm, node_id: 'node-fixture' }, proxyPool })
  assert.equal(remote.ok, false)
  assert.equal(remote.reason, 'exit_guard_unsupported_exit')
  const local = { id: 'px-local', scheme: 'local', host: 'local', port: 0 }
  const direct = resolveImportProxy({
    vm: { id: vm.id, proxy: local },
    proxyPool: {
      snapshot: () => ({ proxies: [{ ...local, enabled: true, status: 'ok' }] }),
      getProxyForVm: () => local,
    },
  })
  assert.equal(direct.ok, false)
  assert.equal(direct.reason, 'exit_guard_unsupported_exit')
  assert.equal(direct.proxyUrl, null)
})

test('opt-in remote Cookie import still requires a verified central guard and forbids override', (t) => {
  requireExitGuard(t)
  const previous = process.env.KIN_CLUSTER_GUARDED_EGRESS
  process.env.KIN_CLUSTER_GUARDED_EGRESS = '1'
  t.after(() => {
    if (previous === undefined) delete process.env.KIN_CLUSTER_GUARDED_EGRESS
    else process.env.KIN_CLUSTER_GUARDED_EGRESS = previous
  })
  const remote = { ...vm, node_id: 'node-fixture' }
  const resolved = resolveImportProxy({ vm: remote, proxyPool, projectRoot: '/missing-fixture' })
  assert.equal(resolved.ok, false)
  assert.equal(resolved.proxyUrl, null)
  assert.equal(resolved.reason, 'exit_ip_required')
  assert.equal(
    resolveImportProxy({ vm: remote, proxyPool, overrideUrl: proxy.url }).reason,
    'exit_guard_override_forbidden',
  )
  assert.equal(
    resolveImportProxy({ vm: { ...remote, platform: 'openai' }, proxyPool }).reason,
    'exit_guard_unsupported_platform',
  )
})

test('a retained expected IP with protection disabled preserves existing proxy behavior', (t) => {
  const settings = requireExitGuard(t)
  settings.set('proxy_exit_guard', {
    required: false,
    proxies: { [proxy.id]: { expected_ip: '203.0.113.10', revision: 'fixture' } },
  })
  assert.equal(resolveImportProxy({ vm, proxyPool }).proxyUrl, proxy.url)
  assert.equal(
    resolveImportProxy({ vm, proxyPool, overrideUrl: 'socks5h://other.invalid:1080' }).proxyUrl,
    'socks5h://other.invalid:1080',
  )
})

test('missing or stale helper state cannot fall back to the raw proxy', (t) => {
  const settings = requireExitGuard(t)
  settings.set('proxy_exit_guard', {
    required: true,
    proxies: { [proxy.id]: { expected_ip: '203.0.113.10', revision: 'fixture' } },
  })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-state-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'data/run/egress', proxy.id)
  for (const state of [
    null,
    { ready: true, expected_ip: '203.0.113.10', revision: 'fixture', checked_at: '2000-01-01' },
  ]) {
    if (state) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'exit-guard-state.json'), JSON.stringify(state))
    }
    const result = resolveImportProxy({ vm, proxyPool, projectRoot: root })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'exit_guard_blocked')
    assert.equal(result.proxyUrl, null)
  }
})

test('OAuth route gate preserves the safe guard reason and cannot be bypassed by mock mode', (t) => {
  requireExitGuard(t)
  const saved = process.env.KIN_CRS_MOCK
  process.env.KIN_CRS_MOCK = '1'
  t.after(() => {
    if (saved === undefined) delete process.env.KIN_CRS_MOCK
    else process.env.KIN_CRS_MOCK = saved
  })
  const { requireSlotProxy } = createImportCommit({ cfg: { paths: { project: '/unused-fixture' } }, proxyPool })
  const result = requireSlotProxy(vm, { proxy_url: 'socks5h://other.invalid:1080', require_proxy: false })
  assert.equal(result.ok, false)
  assert.equal(result.status, 409)
  assert.equal(result.code, 'exit_guard_blocked')
  assert.equal(result.reason, 'exit_guard_override_forbidden')
})

test('raw credential commit cannot import or start a worker before its exit is verified', async (t) => {
  requireExitGuard(t)
  const saved = process.env.KIN_CRS_MOCK
  process.env.KIN_CRS_MOCK = '1'
  t.after(() => {
    if (saved === undefined) delete process.env.KIN_CRS_MOCK
    else process.env.KIN_CRS_MOCK = saved
  })
  let imports = 0
  const { commitImportedOauth } = createImportCommit({
    cfg: { paths: { project: '/unused-fixture' } },
    proxyPool: { snapshot: proxyPool.snapshot, getProxyForVm: () => null },
    importWorkerCredential: async () => {
      imports++
      return { ok: false }
    },
  })
  const result = await commitImportedOauth({
    vmId: vm.id,
    vmPath: '/unused-fixture/vm.json',
    existing: { ...vm, claude: {} },
    oauth: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' },
  })
  assert.equal(result.error.code, 'exit_guard_blocked')
  assert.equal(imports, 0)
})

test('required exit guard blocks API endpoint forwarding before contacting the kernel', async (t) => {
  requireExitGuard(t)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-api-'))
  fs.mkdirSync(path.join(root, 'run'))
  let connections = 0
  const kernel = http.createServer((_req, res) => {
    connections++
    res.end('{}')
  })
  await new Promise((resolve) => kernel.listen(path.join(root, 'run/api-kernel.sock'), resolve))
  t.after(async () => {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (const method of ['POST', 'GET']) {
    await assert.rejects(
      forwardApi({
        cfg: { paths: { data: root, project: root } },
        method,
        url: 'https://provider.invalid/v1/messages',
        proxyUrl: proxy.url,
      }).then((response) => {
        response.resume()
        return response
      }),
      { code: 'exit_guard_api_endpoint_unsupported' },
    )
  }
  assert.equal(connections, 0)
})

test('required exit guard refuses Codex kernel preparation and reuse', async (t) => {
  requireExitGuard(t)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-codex-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  await assert.rejects(ensureCodexKernel({ vmId: vm.id, vm, homeDir: path.join(root, 'cli-home') }), {
    code: 'exit_guard_blocked',
    reason: 'exit_guard_unsupported_platform',
  })
  assert.throws(() => writeCodexKernelConfig(root, vm), {
    code: 'exit_guard_blocked',
    reason: 'exit_guard_unsupported_platform',
  })
  assert.deepEqual(fs.readdirSync(root), [])
})

test('required exit guard closes the shared raw host route used by Codex refresh, catalog, and quota', (t) => {
  const settings = requireExitGuard(t)
  settings.set('proxy_exit_guard', {
    required: true,
    proxies: { [proxy.id]: { expected_ip: '203.0.113.10', revision: 'fixture' } },
  })
  for (const target of [vm, { ...vm, platform: 'openai' }, { ...vm, node_id: 'remote-fixture' }]) {
    assert.throws(() => hostProxyUrlForVm(target), { code: 'exit_guard_blocked' })
  }
})

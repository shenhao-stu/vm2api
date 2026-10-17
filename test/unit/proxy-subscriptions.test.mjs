import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseSubscription } from '../../src/lib/vm/subscription-parse.mjs'
import {
  isPublicAddress,
  resolvePublicHost,
  sourceUrl,
  fetchSubscription,
  SubscriptionError,
} from '../../src/lib/vm/subscription-network.mjs'
import { renderSubscriptionConfig } from '../../src/lib/vm/subscription-runtime.mjs'
import { ProxySubscriptions } from '../../src/lib/vm/proxy-subscriptions.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { handleProxySubscriptions } from '../../src/lib/admin/proxy-subscription-routes.mjs'

const UUID = '00000000-0000-4000-8000-000000000001'
const fixture = (password = 'test-secret', name = 'test node') =>
  JSON.stringify({
    'external-controller': '0.0.0.0:9999',
    'proxy-providers': { arbitrary: { url: 'http://127.0.0.1' } },
    proxies: [{ name, type: 'trojan', server: 'proxy.example.com', port: 443, password }],
  })
const rejectCode = (code) => (error) => error instanceof SubscriptionError && error.code === code

function environment(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-subscriptions-'))
  const db = createDatabase({ dbPath: ':memory:' })
  const pool = new ProxyPool({ db })
  const runtime = {
    nodes: [],
    running: false,
    fail: false,
    status() {
      return { available: true, running: this.running }
    },
    async validate() {
      if (this.fail) throw new SubscriptionError('subscription_runtime')
    },
    async apply(nodes) {
      await this.validate()
      this.nodes = structuredClone(nodes)
      this.running = true
    },
    async close() {
      this.running = false
    },
  }
  const manager = new ProxySubscriptions({
    dataDir: dir,
    proxyPool: pool,
    runtime,
    resolver: async () => ['8.8.8.8'],
    fetcher: async () => Buffer.from(fixture()),
  })
  t.after(async () => {
    await manager.close()
    pool.stopScheduler()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, db, pool, manager, runtime }
}

test('parsing discards supplier controls and accepts equivalent YAML, JSON, base64 and URI nodes', () => {
  const nodes = parseSubscription(fixture())
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].config.password, 'test-secret')
  assert.equal(parseSubscription(Buffer.from(fixture()).toString('base64'))[0].hash, nodes[0].hash)
  const yaml =
    'proxies:\n  - name: test node\n    type: trojan\n    server: proxy.example.com\n    port: 443\n    password: test-secret\n'
  assert.equal(parseSubscription(yaml)[0].hash, nodes[0].hash)
  assert.equal(parseSubscription('trojan://test-secret@proxy.example.com:443#test%20node')[0].hash, nodes[0].hash)
  assert.equal(
    parseSubscription(
      `vless://${UUID}@proxy.example.com:443?security=reality&sni=www.example.com&pbk=publickey&sid=abcd&type=ws&path=%2F#vless`,
    )[0].type,
    'vless',
  )
  assert.equal(
    parseSubscription(
      JSON.stringify({
        proxies: [
          { name: 'h2', type: 'hysteria2', server: '8.8.8.8', port: 443, password: 'test', mport: '2000:3000' },
        ],
      }),
    )[0].config.ports,
    '2000-3000',
  )
})

test('node names do not change identity; endpoint credentials do', () => {
  assert.equal(parseSubscription(fixture('test-secret', 'renamed'))[0].hash, parseSubscription(fixture())[0].hash)
  assert.notEqual(parseSubscription(fixture('changed'))[0].hash, parseSubscription(fixture())[0].hash)
})

test('dangerous fields, aliases, unsupported transports and oversize sources reject without leaking payloads', () => {
  for (const field of ['plugin', 'plugin-opts', 'dialer-proxy', 'interface-name', 'certificate', 'private-key']) {
    const doc = JSON.parse(fixture())
    doc.proxies[0][field] = 'sensitive-value'
    assert.throws(
      () => parseSubscription(JSON.stringify(doc)),
      (error) => !error.message.includes('sensitive-value') && rejectCode('subscription_invalid')(error),
    )
  }
  assert.throws(() => parseSubscription('proxies: &nodes\n  - *nodes'), rejectCode('subscription_invalid'))
  const node = { name: 'vless', type: 'vless', server: '8.8.8.8', port: 443, uuid: UUID, network: 'unknown' }
  assert.throws(() => parseSubscription(JSON.stringify([node])), rejectCode('subscription_invalid'))
  assert.throws(() => parseSubscription('x'.repeat(2 * 1024 * 1024 + 1)), rejectCode('subscription_limit'))
  assert.throws(
    () => parseSubscription(JSON.stringify(Array.from({ length: 257 }, () => JSON.parse(fixture()).proxies[0]))),
    rejectCode('subscription_limit'),
  )
})

test('source and DNS validation rejects private, reserved and mixed public/private DNS answers', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '100.100.100.200',
    '169.254.169.254',
    '192.168.1.1',
    '198.18.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2002:7f00:1::1',
  ])
    assert.equal(isPublicAddress(address), false, address)
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true)
  await assert.rejects(
    resolvePublicHost('proxy.example.com', async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }]),
    rejectCode('subscription_blocked'),
  )
  for (const url of [
    'http://127.1/private',
    'https://user:password@example.com',
    'file:///etc/passwd',
    'http://169.254.169.254/latest',
    'http://localhost',
  ])
    assert.throws(() => sourceUrl(url), rejectCode('subscription_blocked'))
  await assert.rejects(
    fetchSubscription('http://127.0.0.1/secret'),
    (error) => rejectCode('subscription_blocked')(error) && !error.message.includes('secret'),
  )
})

test('generated core config has authenticated private listeners, checked endpoints and no direct default route', () => {
  const node = {
    ...parseSubscription(fixture())[0],
    address: '8.8.8.8',
    id: 'node-1',
    listenPort: 21000,
    username: 'local-user',
    password: 'local-password',
  }
  const config = renderSubscriptionConfig([node], { controller: '127.0.0.1:19090', secret: 'controller-secret' })
  assert.deepEqual(config.rules, ['MATCH,REJECT'])
  assert.equal(config['proxy-providers'], undefined)
  assert.equal(config.listeners[0].listen, '127.0.0.1')
  assert.deepEqual(config.listeners[0].users, [{ username: 'local-user', password: 'local-password' }])
  assert.equal(config.listeners[0].proxy, 'node-1')
  assert.equal(config.proxies[0].server, '8.8.8.8')
  assert.equal(config.proxies[0].sni, 'proxy.example.com')
  assert.throws(
    () => renderSubscriptionConfig([{ ...node, address: '127.0.0.1' }], { controller: '', secret: '' }),
    rejectCode('subscription_blocked'),
  )
})

test('import stores encrypted secrets, maps existing pool, and restart restores stable listener identity', async (t) => {
  const { dir, manager, pool, runtime } = environment(t)
  await manager.start()
  const view = await manager.import({ name: 'test profile', url: 'https://source.example.com/token-test-secret' })
  assert.equal(view.profiles[0].node_count, 1)
  assert.equal(pool.snapshot().proxies[0].managed_subscription, true)
  assert.equal(pool.snapshot().proxies[0].label, 'test node')
  assert.equal(JSON.stringify(view).includes('test-secret'), false)
  const encrypted = fs.readFileSync(path.join(dir, 'subscriptions', 'state.enc'))
  assert.equal(encrypted.includes(Buffer.from('test-secret')), false)
  assert.equal(fs.statSync(path.join(dir, 'subscriptions', 'key')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(dir, 'subscriptions')).mode & 0o777, 0o700)
  const saved = structuredClone(manager.state.nodes[0])
  const restored = new ProxySubscriptions({
    dataDir: dir,
    proxyPool: pool,
    runtime,
    resolver: async () => {
      throw new Error('must not fetch DNS on restore')
    },
  })
  await restored.start()
  assert.equal(restored.view().runtime.running, true)
  assert.deepEqual(restored.state.nodes[0], saved)
  assert.equal(pool.snapshot().proxies.length, 1)
})

test('refresh retains bound old credentials and stable unchanged routes; failed validation keeps previous state', async (t) => {
  const { manager, pool, runtime } = environment(t)
  await manager.start()
  await manager.import({ content: fixture() })
  const original = structuredClone(manager.state.nodes[0]),
    id = manager.state.profiles[0].id
  assert.equal(pool.bind(original.proxyId, 'vm-test').ok, true)
  await manager.import({ id, content: fixture('changed', 'new node') })
  assert.equal(manager.state.nodes.length, 2)
  const retained = manager.state.nodes.find((node) => node.id === original.id)
  assert.equal(retained.retained, true)
  assert.equal(retained.listenPort, original.listenPort)
  assert.equal(pool.getProxyForVm('vm-test').id, original.proxyId)
  const before = JSON.stringify(manager.state)
  runtime.fail = true
  await assert.rejects(manager.import({ id, content: fixture('failed-candidate') }), rejectCode('subscription_runtime'))
  assert.equal(JSON.stringify(manager.state), before)
  runtime.fail = false
  await assert.rejects(manager.remove(id), rejectCode('subscription_bound'))
  pool.setEnabled(original.proxyId, false)
  pool.ensureLocal()
  assert.equal(pool.ensureBoundToVm('vm-test'), null)
  assert.equal(pool.allocateForVm('vm-test'), null)
})

test('unbound refresh removes obsolete routes without reusing retired ports; tamper fails closed', async (t) => {
  const { manager, pool, dir } = environment(t)
  await manager.start()
  await manager.import({ content: fixture() })
  const old = manager.state.nodes[0]
  await manager.import({ id: manager.state.profiles[0].id, content: fixture('new') })
  assert.equal(manager.state.nodes.length, 1)
  assert.ok(manager.state.nodes[0].listenPort > old.listenPort)
  assert.equal(pool.getProxyByIdWithAuth(old.proxyId), null)
  fs.writeFileSync(path.join(dir, 'subscriptions', 'state.enc'), 'tampered')
  await assert.rejects(manager.start(), rejectCode('subscription_storage'))
  assert.equal(manager.runtime.status().running, false)
})

test('admin route rejects other roles before source I/O and hides unexpected exception details', async () => {
  const captured = [],
    res = { setHeader() {} },
    json = (_res, status, body) => captured.push({ status, body })
  const args = {
    req: { method: 'POST' },
    res,
    url: new URL('http://localhost/api/panel/proxy-subscriptions'),
    json,
    manager: {
      import: async () => {
        throw new Error('https://secret.example.com/private-token')
      },
    },
    readBody: async () => ({}),
  }
  await handleProxySubscriptions({
    ...args,
    role: 'user',
    readBody: async () => {
      throw new Error('must not read')
    },
  })
  assert.equal(captured.pop().status, 403)
  await handleProxySubscriptions({ ...args, role: 'admin' })
  const error = captured.pop()
  assert.equal(error.status, 400)
  assert.equal(JSON.stringify(error).includes('private-token'), false)
})

test('fresh process with corrupted or missing encrypted state cannot lose managed provenance or fall back to local', async (t) => {
  const { manager, pool, db, dir, runtime } = environment(t)
  await manager.start()
  await manager.import({ content: fixture() })
  const id = manager.state.nodes[0].proxyId
  pool.bind(id, 'vm-fresh')
  pool.ensureLocal()
  pool.setEnabled(id, false)
  const stateFile = path.join(dir, 'subscriptions', 'state.enc')
  for (const missing of [false, true]) {
    if (missing) fs.rmSync(stateFile)
    else fs.writeFileSync(stateFile, 'corrupt')
    const freshPool = new ProxyPool({ db })
    const fresh = new ProxySubscriptions({ dataDir: dir, proxyPool: freshPool, runtime })
    await assert.rejects(fresh.start(), rejectCode('subscription_storage'))
    assert.equal(freshPool.managedProxyIds.has(id), true)
    assert.equal(freshPool.ensureBoundToVm('vm-fresh'), null)
    assert.equal(freshPool.allocateForVm('vm-fresh'), null)
    assert.equal(runtime.status().running, false)
  }
})

test('stalled node DNS is bounded and releases the mutation lock without changing saved state', async (t) => {
  const { manager } = environment(t)
  await manager.start()
  manager.operationTimeoutMs = 10
  manager.resolver = () => new Promise(() => {})
  await assert.rejects(manager.import({ content: fixture() }), rejectCode('subscription_fetch'))
  assert.equal(manager.busy, false)
  assert.equal(manager.state.nodes.length, 0)
  await assert.rejects(
    resolvePublicHost('proxy.example.com', () => new Promise(() => {}), 10),
    rejectCode('subscription_blocked'),
  )
})

test('managed loopback nodes cannot bind or auto-allocate to a remote cluster slot', async (t) => {
  const { manager, pool } = environment(t)
  pool.vmNodeOf = (id) => (id === 'vm-remote' ? 'remote-node' : null)
  await manager.start()
  await manager.import({ content: fixture() })
  const id = manager.state.nodes[0].proxyId
  assert.equal(pool.bind(id, 'vm-remote').error, 'subscription_local_only')
  assert.equal(pool.allocateForVm('vm-remote'), null)
  assert.equal(pool.bind(id, 'vm-local').ok, true)
  pool.vmNodeOf = () => 'remote-node'
  assert.equal(pool.getProxyForVm('vm-local'), null)
  assert.equal(pool.ensureBoundToVm('vm-local'), null)
})

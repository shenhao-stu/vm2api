import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProxySubscriptions } from '../../src/lib/vm/proxy-subscriptions.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { parseSubscription } from '../../src/lib/vm/subscription-parse.mjs'
import { renderSubscriptionConfig } from '../../src/lib/vm/subscription-runtime.mjs'
import { SubscriptionError } from '../../src/lib/vm/subscription-network.mjs'
import { dispatchClashSubscription } from '../../src/lib/vm/clash-subscriptions.mjs'
import { initClash } from '../../scripts/init-clash.mjs'

const payload = (password = 'fixture-secret', name = 'node') =>
  JSON.stringify({
    proxies: [{ name, type: 'trojan', server: 'proxy.example.com', port: 443, password }],
  })
async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-unified-sub-'))
  const db = createDatabase({ dbPath: ':memory:' })
  const pool = new ProxyPool({ db })
  const clock = { now: Date.parse('2026-11-04T00:00:00Z') }
  const calls = []
  const runtime = {
    running: false,
    status() {
      return { available: true, running: this.running }
    },
    async validate() {},
    async apply(nodes) {
      calls.push(structuredClone(nodes))
      this.running = true
    },
    async close() {
      this.running = false
    },
  }
  const options = {
    dataDir,
    proxyPool: pool,
    runtime,
    now: () => clock.now,
    resolver: async () => ['8.8.8.8'],
    fetcher: async () => payload(),
  }
  const manager = new ProxySubscriptions(options)
  await manager.start()
  t.after(async () => {
    await manager.close()
    pool.stopScheduler()
    db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  return { manager, pool, runtime, calls, options, clock, dataDir }
}
const code = (expected) => (error) => error instanceof SubscriptionError && error.code === expected

test('URL schedule is encrypted and resumes overdue without reload for unchanged routes', async (t) => {
  const { manager, clock, calls, options, dataDir } = await fixture(t)
  await manager.import({ name: 'airport', url: 'https://example.com/sub?token=private-token' })
  const id = manager.state.profiles[0].id
  assert.equal(manager.view().profiles[0].auto_refresh, true)
  assert.equal(manager.view().profiles[0].refresh_interval_minutes, 360)
  const encrypted = fs.readFileSync(path.join(dataDir, 'subscriptions/state.enc'))
  assert.equal(encrypted.includes('private-token'), false)
  assert.equal(encrypted.includes('fixture-secret'), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'clash/subscriptions.json')), false)
  assert.equal(JSON.stringify(manager.view()).includes('private-token'), false)
  await manager.runDue()
  assert.equal(calls.length, 1)
  clock.now += 360 * 60000
  await manager.runDue()
  assert.equal(calls.length, 1)
  manager.configure(id, { auto_refresh: false, refresh_interval_minutes: 30 })
  clock.now += 360 * 60000
  await manager.runDue()
  assert.equal(calls.length, 1)
  manager.configure(id, { auto_refresh: true })
  clock.now += 31 * 60000
  const restored = new ProxySubscriptions(options)
  await restored.start()
  const prior = calls.length
  await restored.runDue()
  assert.equal(calls.length, prior)
  assert.equal(restored.view().profiles[0].last_success_at, new Date(clock.now).toISOString())
  await restored.close()
})

test('changed credentials, missing bound nodes and changed DNS block whole refresh without touching routes', async (t) => {
  const { manager, pool, calls, clock } = await fixture(t)
  await manager.import({ url: 'https://example.com/sub' })
  const id = manager.state.profiles[0].id
  pool.bind(manager.state.nodes[0].proxyId, 'vm-bound')
  const nodes = structuredClone(manager.state.nodes)
  const beforePool = structuredClone(pool.state)
  for (const change of [
    () => {
      manager.fetcher = async () => payload('rotated')
    },
    () => {
      manager.fetcher = async () => payload()
      manager.resolver = async () => ['1.1.1.1']
    },
  ]) {
    change()
    await assert.rejects(manager.refresh(id), code('subscription_bound_changed'))
    assert.deepEqual(manager.state.nodes, nodes)
    assert.deepEqual(pool.state, beforePool)
    assert.equal(calls.length, 1)
    const profile = manager.view().profiles[0]
    assert.equal(profile.last_error, 'subscription_bound_changed')
    assert.equal(profile.next_refresh_at, new Date(clock.now + 15 * 60000).toISOString())
  }
})

test('rename refresh keeps endpoint identity and manual disable; explicit reimport retains bound old route', async (t) => {
  const { manager, pool, calls } = await fixture(t)
  await manager.import({ url: 'https://example.com/sub' })
  const id = manager.state.profiles[0].id
  const node = manager.state.nodes[0]
  pool.bind(node.proxyId, 'vm-bound')
  pool.setEnabled(node.proxyId, false)
  manager.fetcher = async () => payload('fixture-secret', 'renamed')
  await manager.refresh(id)
  assert.equal(calls.length, 1)
  assert.equal(manager.state.nodes[0].id, node.id)
  assert.equal(pool.state.proxies.find((p) => p.id === node.proxyId).enabled, false)
  await manager.import({ id, content: payload('new-credentials') })
  assert.equal(manager.state.nodes.length, 2)
  assert.equal(manager.state.nodes.find((n) => n.id === node.id).retained, true)
  assert.equal(manager.view().profiles[0].auto_refresh, false)
})

test('refresh failures redact supplier messages, retain last success and retry after 15 minutes', async (t) => {
  const { manager, calls, clock } = await fixture(t)
  await manager.import({ url: 'https://example.com/sub' })
  const id = manager.state.profiles[0].id
  const success = manager.view().profiles[0].last_success_at
  const nodes = structuredClone(manager.state.nodes)
  clock.now += 360 * 60000
  manager.fetcher = async () => {
    throw new Error('secret-token-from-provider')
  }
  await manager.runDue()
  const view = manager.view()
  assert.equal(view.profiles[0].last_error, 'subscription_refresh_failed')
  assert.equal(view.profiles[0].last_success_at, success)
  assert.equal(JSON.stringify(view).includes('secret-token'), false)
  assert.deepEqual(manager.state.nodes, nodes)
  assert.equal(calls.length, 1)
})

test('scheduler serializes due runs and validates options before fetching', async (t) => {
  const { manager, clock } = await fixture(t)
  await manager.import({ url: 'https://example.com/sub', refresh_interval_minutes: 15 })
  const id = manager.state.profiles[0].id
  for (const input of [{ auto_refresh: 'true' }, { refresh_interval_minutes: 0 }, { refresh_interval_minutes: 10081 }])
    assert.throws(() => manager.configure(id, input), code('subscription_invalid'))
  clock.now += 15 * 60000
  let release,
    downloads = 0
  manager.fetcher = () => {
    downloads++
    return new Promise((resolve) => {
      release = resolve
    })
  }
  const running = manager.runDue()
  await manager.runDue()
  assert.equal(downloads, 1)
  assert.throws(() => manager.configure(id, { auto_refresh: false }), code('subscription_busy'))
  release(payload())
  await running
  assert.equal(manager.busy, false)
})

test('Fwind protocols use safe explicit schemas and malicious nested options fail closed', () => {
  const key = Buffer.alloc(32, 1).toString('base64')
  const variants = [
    { type: 'ssr', cipher: 'aes-128-cfb', password: 'p', obfs: 'plain', protocol: 'origin' },
    { type: 'hysteria', 'auth-str': 'p', protocol: 'udp', up: 10, down: 50 },
    { type: 'snell', psk: 'p', version: 3, 'obfs-opts': { mode: 'http', host: 'example.com' } },
    { type: 'anytls', password: 'p', 'idle-session-timeout': 30 },
    { type: 'mieru', username: 'u', password: 'p', transport: 'TCP' },
    { type: 'ssh', username: 'u', password: 'p', 'host-key': ['ssh-ed25519 fixture'] },
    {
      type: 'wireguard',
      ip: '10.0.0.2',
      'private-key': key,
      'public-key': key,
      reserved: [0, 1, 255],
      dns: ['8.8.8.8'],
    },
  ]
  for (const variant of variants) {
    const node = { name: variant.type, server: 'proxy.example.com', port: 443, ...variant }
    assert.equal(parseSubscription(JSON.stringify({ proxies: [node] }))[0].type, variant.type)
    for (const unsafe of [
      { 'dialer-proxy': 'DIRECT' },
      { 'private-key-path': '/etc/passwd' },
      { 'interface-name': 'eth0' },
    ])
      assert.throws(
        () => parseSubscription(JSON.stringify({ proxies: [{ ...node, ...unsafe }] })),
        code('subscription_invalid'),
      )
  }
  assert.throws(
    () =>
      parseSubscription(
        JSON.stringify({
          proxies: [{ name: 'wg', server: '8.8.8.8', port: 443, ...variants.at(-1), dns: ['127.0.0.1'] }],
        }),
      ),
    code('subscription_blocked'),
  )
  assert.throws(
    () => parseSubscription('proxies: [&x {name: bad, type: ss, nested: *x}]'),
    code('subscription_invalid'),
  )
})

test('ECH uses fixed DoH and pinned endpoint while supplier controller, DNS, rules never execute', () => {
  const input = JSON.parse(payload())
  input.proxies[0]['ech-opts'] = { enable: true, 'query-server-name': 'cloudflare-ech.com' }
  input.dns = { enable: false, nameserver: ['127.0.0.1'] }
  input.rules = ['MATCH,DIRECT']
  input['external-controller'] = '0.0.0.0:9090'
  const nodes = parseSubscription(JSON.stringify(input)).map((n) => ({
    ...n,
    id: 'fixed',
    address: '8.8.8.8',
    listenPort: 38000,
    username: 'u',
    password: 'p',
  }))
  const config = renderSubscriptionConfig(nodes, { controller: '127.0.0.1:19090', secret: 's' })
  assert.deepEqual(config.dns.nameserver, ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'])
  assert.equal(config.dns.enable, true)
  assert.equal(config.proxies[0].server, '8.8.8.8')
  assert.equal(config.proxies[0].sni, 'proxy.example.com')
  assert.deepEqual(config.proxies[0]['ech-opts'], input.proxies[0]['ech-opts'])
  assert.equal(config.proxies[0]['skip-cert-verify'], undefined)
  assert.deepEqual(config.rules, ['MATCH,REJECT'])
})

test('legacy import adapter has same encrypted state, manager, stable hashes and scheduler', async (t) => {
  const { manager, dataDir } = await fixture(t)
  const result = await dispatchClashSubscription(manager, { name: 'legacy', yaml: payload() })
  const id = result.sources[0].id
  await dispatchClashSubscription(manager, { name: 'legacy', yaml: payload() })
  assert.equal(manager.state.profiles.length, 1)
  assert.equal(manager.state.profiles[0].id, id)
  assert.equal(fs.existsSync(path.join(dataDir, 'clash')), false)
  await assert.rejects(dispatchClashSubscription(manager, { action: 'unknown' }), code('subscription_invalid'))
  await assert.rejects(
    dispatchClashSubscription(manager, { action: 'configure', source_id: id, auto_refresh: true }),
    code('subscription_invalid'),
  )
})

test('legacy init never writes plaintext state and refuses ambiguous old storage', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-clash-init-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  assert.deepEqual(initClash({ dataDir, binary: process.execPath }), { created: false, managed: true })
  assert.deepEqual(fs.readdirSync(dataDir), [])
  fs.mkdirSync(path.join(dataDir, 'clash'))
  fs.writeFileSync(path.join(dataDir, 'clash/subscriptions.json'), '{}')
  assert.throws(() => initClash({ dataDir, binary: process.execPath }), /Legacy sidecar state/)
})

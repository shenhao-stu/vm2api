import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createEgressBridge } from '../../src/lib/vm/egress-network.mjs'
import { ensureEgressNetwork, ensureLocalProxyEgress } from '../../src/lib/vm/egress.mjs'

const exhausted = { ok: false, stderr: 'all predefined address pools have been fully subnetted' }
const success = (value) => ({ ok: true, stdout: JSON.stringify(value), stderr: '' })
const noIp = () => assert.fail('host inventory must not run')

function fixture({
  routes = [{ dst: 'default' }],
  addresses,
  networks,
  inventoryError,
  collisions = 0,
  createError,
} = {}) {
  const dockerCalls = []
  const ipCalls = []
  const raced = []
  let created = null
  let attempts = 0
  const inventory = networks || [{ IPAM: { Config: [{ Subnet: '172.17.0.0/16' }] } }]
  const runDocker = (args) => {
    dockerCalls.push(args)
    if (args[1] === 'ls') return { ok: true, stdout: 'aaaaaaaaaaaa\n' }
    if (args[1] === 'inspect' && args[2] === '-f') {
      return created
        ? { ok: true, stdout: `${created.subnet}|${created.gateway}|${JSON.stringify(created.labels)}` }
        : { ok: false, stderr: 'not found' }
    }
    if (args[1] === 'inspect') {
      if (inventoryError) return inventoryError
      return success(
        inventory.map((n, i) =>
          i
            ? n
            : {
                ...n,
                IPAM: { ...n.IPAM, Config: [...(n.IPAM?.Config || []), ...raced.map((Subnet) => ({ Subnet }))] },
              },
        ),
      )
    }
    assert.equal(args[1], 'create')
    if (!args.includes('--subnet')) return exhausted
    attempts++
    const subnet = args[args.indexOf('--subnet') + 1]
    if (attempts <= collisions) {
      raced.push(subnet)
      return { ok: false, stderr: 'invalid pool request: Pool overlaps with other one on this address space' }
    }
    if (createError) return createError
    created = {
      subnet,
      gateway: args[args.indexOf('--gateway') + 1],
      labels: Object.fromEntries(args.flatMap((value, i) => (value === '--label' ? [args[i + 1].split('=')] : []))),
    }
    return { ok: true, stdout: 'new-network-id' }
  }
  const runIp = (args) => {
    ipCalls.push(args)
    if (args.includes('route')) return success(routes)
    assert.ok(args.includes('address'))
    return success(addresses || [{ addr_info: [{ family: 'inet', local: '192.0.2.5', prefixlen: 24 }] }])
  }
  return { runDocker, runIp, dockerCalls, ipCalls, explicit: () => dockerCalls.filter((a) => a.includes('--subnet')) }
}

const create = (f, masquerade = false) => createEgressBridge('kin-eg-px-test', 'kegtest', { ...f, masquerade })

test('normal Docker allocation is unchanged and does not read host inventory', () => {
  const result = { ok: true, stdout: 'normal-network' }
  const calls = []
  assert.equal(
    createEgressBridge('net', 'br', {
      masquerade: false,
      runIp: noIp,
      runDocker: (args) => {
        calls.push(args)
        return result
      },
    }),
    result,
  )
  assert.equal(calls.length, 1)
  assert.ok(!calls[0].includes('--subnet'))
})

test('unrelated Docker failures never enable fallback', () => {
  const result = { ok: false, stderr: 'permission denied' }
  assert.equal(createEgressBridge('net', 'br', { masquerade: false, runDocker: () => result, runIp: noIp }), result)
})

test('pool exhaustion selects explicit subnet, preserves bridge isolation and uses all host tables', () => {
  const f = fixture()
  assert.equal(create(f).ok, true)
  const [args] = f.explicit()
  assert.match(args[args.indexOf('--subnet') + 1], /^10\.203\.\d+\.0\/24$/)
  assert.equal(args[args.indexOf('--gateway') + 1], args[args.indexOf('--subnet') + 1].replace('.0/24', '.1'))
  for (const option of [
    '--ipv6=false',
    'com.docker.network.bridge.name=kegtest',
    'com.docker.network.bridge.enable_ip_masquerade=false',
    'com.docker.network.bridge.enable_icc=false',
  ])
    assert.ok(args.includes(option))
  assert.deepEqual(f.ipCalls, [
    ['-j', '-4', 'route', 'show', 'table', 'all'],
    ['-j', '-4', 'address', 'show'],
  ])
  assert.ok(f.dockerCalls.every((a) => a[0] === 'network' && ['create', 'ls', 'inspect'].includes(a[1])))
})

test('the alternative Docker exhaustion message also enables fallback', () => {
  const f = fixture()
  const runDocker = f.runDocker
  f.runDocker = (args) =>
    args[1] === 'create' && !args.includes('--subnet')
      ? { ok: false, stderr: 'could not find an available, non-overlapping IPv4 address pool among the defaults' }
      : runDocker(args)
  assert.equal(create(f).ok, true)
  assert.equal(f.explicit().length, 1)
})

test('subnet selection is stable for an unchanged network inventory', () => {
  const a = fixture()
  const b = fixture()
  create(a)
  create(b)
  assert.deepEqual(a.explicit(), b.explicit())
})

test('an occupied Docker subnet is skipped', () => {
  const first = fixture()
  create(first)
  const subnet = first.explicit()[0][first.explicit()[0].indexOf('--subnet') + 1]
  const f = fixture({ networks: [{ IPAM: { Config: [{ Subnet: subnet }, { Subnet: 'fd00::/64' }] } }] })
  assert.equal(create(f).ok, true)
  assert.notEqual(f.explicit()[0][f.explicit()[0].indexOf('--subnet') + 1], subnet)
})

for (const [label, options] of [
  ['Docker network', { networks: [{ IPAM: { Config: [{ Subnet: '10.0.0.0/8' }] } }] }],
  ['host policy route', { routes: [{ dst: '10.203.0.0/16', table: 100 }] }],
  ['interface prefix', { addresses: [{ addr_info: [{ family: 'inet', local: '10.203.7.1', prefixlen: 16 }] }] }],
]) {
  test(`${label} overlapping the whole reserve refuses creation`, () => {
    const f = fixture(options)
    const result = create(f)
    assert.equal(result.ok, false)
    assert.match(result.stderr, /no non-overlapping/)
    assert.equal(f.explicit().length, 0)
  })
}

for (const [label, options] of [
  ['unavailable Docker inventory', { inventoryError: { ok: false, stderr: 'daemon unavailable' } }],
  ['invalid inventory JSON', { inventoryError: { ok: true, stdout: '{' } }],
  ['missing route prefix', { routes: [{}] }],
  ['empty route inventory', { routes: [] }],
  ['invalid route prefix', { routes: [{ dst: '10.203.0.0/33' }] }],
  ['empty address inventory', { addresses: [] }],
  ['missing interface addresses', { addresses: [{}] }],
  ['no IPv4 interface prefixes', { addresses: [{ addr_info: [] }] }],
]) {
  test(`${label} fails closed before explicit creation`, () => {
    const f = fixture(options)
    const result = create(f)
    assert.equal(result.ok, false)
    assert.match(result.stderr, /fallback refused/)
    assert.equal(f.explicit().length, 0)
  })
}

test('overlap races refresh inventory and choose a different subnet', () => {
  const f = fixture({ collisions: 1 })
  assert.equal(create(f).ok, true)
  assert.equal(f.explicit().length, 2)
  assert.notDeepEqual(f.explicit()[0], f.explicit()[1])
  assert.equal(f.ipCalls.length, 4)
})

test('persistent overlap races stop after four explicit creates', () => {
  const f = fixture({ collisions: 10 })
  const result = create(f)
  assert.equal(result.ok, false)
  assert.match(result.stderr, /raced 4 times/)
  assert.equal(f.explicit().length, 4)
})

test('a non-overlap create error is returned without retry', () => {
  const error = { ok: false, stderr: 'iptables unavailable' }
  const f = fixture({ createError: error })
  assert.equal(create(f), error)
  assert.equal(f.explicit().length, 1)
})

for (const local of [false, true]) {
  test(`${local ? 'local' : 'remote'} ensure reuses persistent state on second call`, () => {
    const f = fixture()
    const ensure = () =>
      local ? ensureLocalProxyEgress({ id: 'px-local' }, f) : ensureEgressNetwork('px-test', f.runDocker, f.runIp)
    const first = ensure()
    assert.equal(first.ok, true)
    assert.equal(first.reused, false)
    assert.ok(f.explicit()[0].includes(`com.docker.network.bridge.enable_ip_masquerade=${local}`))
    const persisted = JSON.stringify(f.explicit())
    const ipCount = f.ipCalls.length
    const second = ensure()
    assert.equal(second.ok, true)
    assert.equal(second.reused, true)
    assert.equal(second.subnet, first.subnet)
    assert.equal(second.gateway, first.gateway)
    assert.equal(JSON.stringify(f.explicit()), persisted)
    assert.equal(f.ipCalls.length, ipCount)
  })
}

for (const fallback of [false, true]) {
  test(`instance ownership labels survive ${fallback ? 'fallback' : 'default'} network allocation`, () => {
    const f = fixture()
    const calls = []
    const labels = { 'vm2api.instance': 'hosted', 'vm2api.resource': 'proxy:px-test' }
    const result = createEgressBridge('scoped-network', 'scoped-bridge', {
      masquerade: false,
      labels,
      runIp: f.runIp,
      runDocker: (args) => {
        calls.push(args)
        return fallback ? f.runDocker(args) : { ok: true, stdout: 'created' }
      },
    })
    assert.equal(result.ok, true)
    for (const args of calls.filter((call) => call[1] === 'create')) {
      for (const [key, value] of Object.entries(labels)) {
        const index = args.indexOf(`${key}=${value}`)
        assert.ok(index > 0, `${key} label missing`)
        assert.equal(args[index - 1], '--label')
      }
    }
  })
}

function withNamedInstance(fn) {
  const values = {
    VM2API_INSTANCE_ID: 'hosted',
    VM2API_EGRESS_PORT_RANGE: '40000-55999',
    VM2API_SUBSCRIPTION_PORT_RANGE: '38000-39999',
  }
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  try {
    return fn()
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

for (const local of [false, true]) {
  test(`named ${local ? 'local' : 'proxy'} fallback preserves ownership and reuses its own network`, () =>
    withNamedInstance(() => {
      const f = fixture()
      const ensure = () =>
        local ? ensureLocalProxyEgress({ id: 'px-local' }, f) : ensureEgressNetwork('px-test', f.runDocker, f.runIp)
      const first = ensure()
      assert.equal(first.ok, true)
      assert.match(first.network, /^kin-eg-i6-hosted-/)
      const count = f.dockerCalls.length
      const second = ensure()
      assert.equal(second.reused, true)
      assert.equal(f.dockerCalls.length, count + 1, 'only ownership inspection is needed for reuse')
    }))
}

for (const labels of [
  {},
  { 'vm2api.instance': 'c2a', 'vm2api.resource': 'proxy:px-test' },
  { 'vm2api.instance': 'hosted', 'vm2api.resource': 'proxy:px-other' },
]) {
  test(`same-name foreign network is rejected without mutation: ${JSON.stringify(labels)}`, () =>
    withNamedInstance(() => {
      const calls = []
      assert.throws(
        () =>
          ensureEgressNetwork(
            'px-test',
            (args) => {
              calls.push(args)
              return { ok: true, stdout: `10.203.12.0/24|10.203.12.1|${JSON.stringify(labels)}` }
            },
            noIp,
          ),
        { code: 'instance_scope_conflict' },
      )
      assert.equal(calls.length, 1)
      assert.equal(calls[0][1], 'inspect')
    }))
}

test('host namespace adapter permits only the two read-only IP inventory commands', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-net-adapter-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
  const adapter = path.resolve(import.meta.dirname, '../../scripts/docker-host-net.sh')
  const run = (args) =>
    spawnSync('/bin/sh', [adapter, 'ip', ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    })
  for (const args of [
    ['-j', '-4', 'route', 'show', 'table', 'all'],
    ['-j', '-4', 'address', 'show'],
  ]) {
    const result = run(args)
    assert.equal(result.status, 0)
    assert.deepEqual(result.stdout.trim().split('\n'), [
      'run',
      '--rm',
      '--network',
      'host',
      '--pid',
      'host',
      '--privileged',
      '--entrypoint',
      'ip',
      'nicolaka/netshoot',
      ...args,
    ])
  }
  for (const args of [
    ['route', 'del', 'default'],
    ['-j', '-4', 'route', 'show', 'table', 'all', ';', 'false'],
    ['-batch', '-'],
  ]) {
    const result = run(args)
    assert.equal(result.status, 127)
    assert.equal(result.stdout, '')
  }
})

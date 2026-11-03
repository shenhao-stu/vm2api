import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { instanceLabels } from '../../src/lib/vm/instance-scope.mjs'
import {
  buildCreateSpec,
  listContainers,
  containerAction,
  removeContainer,
  renameContainer,
  containerLogs,
  execDetached,
  openExecTty,
  inspectContainerOrNull,
  removeNetwork,
} from '../../src/lib/cluster/docker-remote.mjs'
import { collectLocalStatus } from '../../src/lib/cluster/local-status.mjs'

function scoped(t) {
  const values = {
    VM2API_INSTANCE_ID: 'hosted',
    VM2API_SUBSCRIPTION_PORT_RANGE: '38000-39999',
    VM2API_EGRESS_PORT_RANGE: '40000-55999',
  }
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  t.after(() => {
    for (const [key, value] of Object.entries(before))
      value === undefined ? delete process.env[key] : (process.env[key] = value)
  })
}

async function docker(t) {
  const seen = []
  const rows = [
    { Id: 'own', Names: ['/own'], Labels: instanceLabels('slot:vm-01'), Image: 'runner', State: 'running' },
    {
      Id: 'foreign',
      Names: ['/foreign'],
      Labels: { 'vm2api.instance': 'other', 'vm2api.resource': 'slot:vm-01' },
      State: 'running',
    },
    { Id: 'legacy', Names: ['/legacy'], Labels: {}, State: 'running' },
  ]
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, path: req.url })
    const reply = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    if (req.url.startsWith('/containers/json')) return reply(200, rows)
    const item = /^\/containers\/([^/]+)\/json$/.exec(req.url)
    if (item)
      return reply(200, { Id: item[1], Config: { Labels: rows.find((row) => row.Id === item[1])?.Labels || {} } })
    if (req.url === '/networks/foreign') return reply(200, { Labels: rows[1].Labels })
    if (req.url === '/version') return reply(200, { Version: 'fake' })
    if (req.url === '/info') return reply(200, { Containers: 3, ContainersRunning: 3 })
    if (req.url.startsWith('/containers/own/stats')) return reply(200, { memory_stats: { usage: 1024 } })
    if (req.method === 'POST' && req.url === '/containers/own/stop') {
      res.writeHead(204)
      return res.end()
    }
    return reply(500, { message: 'unexpected request' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  const connect = () =>
    new Promise((resolve, reject) => {
      const sock = net.connect(server.address().port, '127.0.0.1')
      sock.once('connect', () => resolve(sock))
      sock.once('error', reject)
    })
  return { seen, connect }
}

test('named instance lists and accounts only its own slots even if a daemon ignores list filters', async (t) => {
  scoped(t)
  const { connect, seen } = await docker(t)
  assert.deepEqual(
    (await listContainers(connect)).map((row) => row.id),
    ['own'],
  )
  const status = await collectLocalStatus({
    listen: { host: '127.0.0.1', port: 18888 },
    observer: null,
    routing: {},
    docker: connect,
  })
  assert.equal(status.docker.slots, 1)
  assert.equal(status.docker.slots_mem, 1024)
  assert.equal(
    seen.some((req) => /foreign\/stats|legacy\/stats/.test(req.path)),
    false,
  )
  const spec = buildCreateSpec({ image: 'nginx', name: 'own' })
  assert.equal(spec.body.Labels['vm2api.instance'], 'hosted')
})

test('direct IDs cannot stop, delete, exec into or read logs of another instance or legacy service', async (t) => {
  scoped(t)
  const { connect, seen } = await docker(t)
  for (const id of ['foreign', 'legacy']) {
    for (const operation of [
      () => containerAction(connect, id, 'stop'),
      () => containerAction(connect, id, 'restart'),
      () => removeContainer(connect, id),
      () => renameContainer(connect, id, 'stolen'),
      () => containerLogs(connect, id),
      () => execDetached(connect, id, ['true']),
      () => openExecTty(connect, id, { cmd: ['sh'] }),
      () => inspectContainerOrNull(connect, id),
    ])
      await assert.rejects(operation, { code: 'instance_scope_conflict' })
  }
  await assert.rejects(removeNetwork(connect, 'foreign'), { code: 'instance_scope_conflict' })
  assert.equal(
    seen.every((req) => req.method === 'GET'),
    true,
  )
  await containerAction(connect, 'own', 'stop')
  assert.deepEqual(seen.at(-1), { method: 'POST', path: '/containers/own/stop' })
})

test('local slot stop and delete reject a conflicting name before Docker mutation', async (t) => {
  scoped(t)
  const { stopVmRuntime, destroyVmRuntime, containerName } = await import('../../src/lib/vm/vm-runtime.mjs')
  const vm = { id: 'vm-01', runtime: { type: 'docker' } }
  const seen = []
  const run = (argv) => {
    seen.push(argv)
    assert.equal(argv[1], 'inspect')
    assert.equal(argv.at(-1), containerName(vm.id))
    return { ok: true, stdout: 'true|123|host|start|runner|host|docker||false|no|other|slot:vm-01' }
  }
  assert.throws(() => stopVmRuntime(vm, { run }), { code: 'instance_scope_conflict' })
  assert.throws(() => destroyVmRuntime(vm, { run }), { code: 'instance_scope_conflict' })
  assert.equal(seen.length, 2)
})

test('direct-link gate uses its scoped name and refuses foreign ownership before remote deletion', async (t) => {
  scoped(t)
  const { gateContainerName } = await import('../../src/lib/vm/instance-scope.mjs')
  const { removeNodeGate, gateContainer } = await import('../../src/lib/cluster/direct-link.mjs')
  const { connect, seen } = await docker(t)
  const host = { root: '/home/u/.vm2api/i/hosted', uid: 1000, gid: 1000 }
  let commands = 0
  await assert.rejects(
    removeNodeGate({
      client: {
        exec() {
          commands++
        },
      },
      host,
      docker: connect,
    }),
    { code: 'instance_scope_conflict' },
  )
  assert.deepEqual(seen, [{ method: 'GET', path: `/containers/${gateContainerName()}/json` }])
  assert.equal(commands, 0)
  const { spec } = gateContainer({ host, imageRef: 'runner', body: '{}', binaryDigest: 'fixture' })
  assert.deepEqual(spec.Labels['vm2api.instance'], 'hosted')
  assert.deepEqual(spec.Labels['vm2api.resource'], 'gate')
  assert.equal(
    spec.HostConfig.Binds.every((mount) => mount.startsWith(`${host.root}/`)),
    true,
  )
})

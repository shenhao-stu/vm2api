import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildHostMap,
  discoverSelfMounts,
  mapHostPath,
  parseMounts,
  resetHostPathCache,
  toHostPath,
} from '../../src/lib/vm/host-path.mjs'

const PROJECT = '/opt/vm2api'

function mountsJson(pairs) {
  return JSON.stringify(pairs.map(([Source, Destination]) => ({ Source, Destination, Type: 'bind' })))
}

test('slot mounts resolve to host paths when the install dir is not /opt/vm2api', () => {
  const entries = buildHostMap({ projectRoot: PROJECT, hostRoot: '/srv/stack/vm2api' })
  assert.equal(mapHostPath('/opt/vm2api/vms/vm-01/cli-home', entries), '/srv/stack/vm2api/vms/vm-01/cli-home')
  assert.equal(mapHostPath('/opt/vm2api/bin/kin-worker', entries), '/srv/stack/vm2api/bin/kin-worker')
})

test('per-mount sources win over the project root, including named volumes', () => {
  const entries = buildHostMap({
    projectRoot: PROJECT,
    hostRoot: '/srv/stack/vm2api',
    mounts: parseMounts(
      mountsJson([
        ['/var/lib/docker/volumes/vm2api_vms/_data', '/opt/vm2api/vms'],
        ['/srv/stack/vm2api/bin', '/opt/vm2api/bin'],
      ]),
    ),
  })
  assert.equal(mapHostPath('/opt/vm2api/vms/vm-02/run', entries), '/var/lib/docker/volumes/vm2api_vms/_data/vm-02/run')
  assert.equal(mapHostPath('/opt/vm2api/bin/kin-kernel', entries), '/srv/stack/vm2api/bin/kin-kernel')
})

test('paths outside the project tree are never rewritten', () => {
  const entries = buildHostMap({ projectRoot: PROJECT, hostRoot: '/srv/stack/vm2api' })
  assert.equal(mapHostPath('/var/run/docker.sock', entries), '/var/run/docker.sock')
  assert.equal(mapHostPath('/opt/vm2api-other/data', entries), '/opt/vm2api-other/data')
})

test('native deploy maps to itself when nothing is configured', () => {
  const entries = buildHostMap({ projectRoot: PROJECT })
  assert.equal(mapHostPath('/opt/vm2api/vms/vm-01', entries), '/opt/vm2api/vms/vm-01')
})

test('self-inspection skips containers that do not carry the project tree', () => {
  const seen = []
  const mounts = discoverSelfMounts({
    projectRoot: PROJECT,
    sockPath: new URL(import.meta.url), // any existing file stands in for a mounted docker.sock
    names: ['not-us', 'vm2api'],
    dockerJson: (name) => {
      seen.push(name)
      if (name === 'not-us') return mountsJson([['/elsewhere', '/srv/other']])
      return mountsJson([['/srv/stack/vm2api/vms', '/opt/vm2api/vms']])
    },
  })
  assert.deepEqual(seen.slice(0, 2), ['not-us', 'vm2api'])
  assert.deepEqual(mounts, [{ source: '/srv/stack/vm2api/vms', destination: '/opt/vm2api/vms' }])
})

test('explicit host root env overrides discovery', () => {
  resetHostPathCache()
  const mapped = toHostPath('/opt/vm2api/vms/vm-03/run', {
    projectRoot: PROJECT,
    env: { VM2API_HOST_ROOT: '/data/vm2api' },
    sockPath: '/nonexistent-docker-sock',
  })
  resetHostPathCache()
  assert.equal(mapped, '/data/vm2api/vms/vm-03/run')
})

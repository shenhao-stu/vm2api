import test from 'node:test'
import assert from 'node:assert/strict'
import {
  instanceId,
  instancePortRanges,
  instanceLabels,
  ownsInstanceResource,
  assertInstanceOwner,
  slotContainerName,
  slotContainerForVm,
  egressIdentity,
} from '../../src/lib/vm/instance-scope.mjs'

const hosted = {
  VM2API_INSTANCE_ID: 'hosted',
  VM2API_SUBSCRIPTION_PORT_RANGE: '38000-39999',
  VM2API_EGRESS_PORT_RANGE: '40000-55999',
}
const other = { ...hosted, VM2API_INSTANCE_ID: 'other' }

test('unnamed deployments retain legacy names, ports and recorded custom slot containers', () => {
  assert.equal(instanceId({}), '')
  assert.equal(slotContainerName('vm-03', {}), 'kin-03')
  assert.equal(slotContainerForVm({ id: 'vm-03', runtime: { container: 'old-custom' } }, {}), 'old-custom')
  assert.deepEqual(instancePortRanges({}), {
    subscription: { first: 21000, last: 22999 },
    egress: { first: 20000, last: 35999 },
  })
  assert.equal(egressIdentity('px-local', {}).network, 'kin-eg-px-local')
  assert.equal(egressIdentity('px-a1b2c3d4', {}).bridge, 'kega1b2c3d4')
  assert.equal(egressIdentity('px-a1b2c3d4', {}).chain, 'KEGa1b2c3d4')
  assert.deepEqual(instanceLabels('slot:vm-03', {}), {})
})

test('invalid instance identifiers and incomplete or overlapping port allocations fail closed', () => {
  for (const id of [' ', ' hosted', 'HOSTED', '../hosted', 'a'.repeat(33), 'hosted\n', '0hosted']) {
    assert.throws(() => instanceId({ VM2API_INSTANCE_ID: id }), { code: 'instance_scope_invalid' })
  }
  assert.throws(() => instancePortRanges({ VM2API_INSTANCE_ID: 'hosted' }), /required/)
  for (const range of ['80-81', ' 40000-55999', '40000-65536', '40001-55999', '40000-55998', '55999-40000']) {
    assert.throws(() => instancePortRanges({ ...hosted, VM2API_EGRESS_PORT_RANGE: range }), {
      code: 'instance_scope_invalid',
    })
  }
  assert.throws(() => instancePortRanges({ ...hosted, VM2API_EGRESS_PORT_RANGE: '39000-54999' }), /overlap/)
})

test('same slot and local exit belong to different instance resources without truncation aliases', () => {
  assert.notEqual(slotContainerName('vm-01', hosted), slotContainerName('vm-01', other))
  assert.notEqual(slotContainerName('vm-01', hosted), slotContainerName('01', hosted))
  assert.notEqual(
    slotContainerName('b-vm', { ...hosted, VM2API_INSTANCE_ID: 'a' }),
    slotContainerName('vm', { ...hosted, VM2API_INSTANCE_ID: 'a-b' }),
  )
  const a = egressIdentity('px-local', hosted),
    b = egressIdentity('px-local', other)
  for (const field of ['network', 'bridge', 'chain']) assert.notEqual(a[field], b[field])
  assert.ok(a.bridge.length <= 15)
  assert.ok(a.chain.length <= 28)
  assert.deepEqual(a, egressIdentity('px-local', hosted))
  const common = 'px-' + 'a'.repeat(32)
  assert.notEqual(egressIdentity(common + '1', hosted).bridge, egressIdentity(common + '2', hosted).bridge)
  for (let i = 0; i < 1000; i++) {
    const { ports } = egressIdentity(`px-${i}`, hosted)
    assert.ok(ports.tcp >= 40000 && ports.dns <= 55999)
    assert.equal(ports.dns, ports.tcp + 1)
  }
})

test('resource ownership checks full instance and resource identities, not short hashes', () => {
  const labels = instanceLabels('proxy:px-local', hosted)
  assert.equal(ownsInstanceResource(labels, 'proxy:px-local', hosted), true)
  assert.equal(ownsInstanceResource(labels, null, other), false)
  assert.equal(ownsInstanceResource(labels, null, {}), false)
  assert.throws(() => assertInstanceOwner({}, 'proxy:px-local', hosted), { code: 'instance_scope_conflict' })
  assert.throws(() => assertInstanceOwner(labels, 'proxy:px-other', hosted), { code: 'instance_scope_conflict' })
  assert.throws(() => slotContainerForVm({ id: 'vm-01', runtime: { container: 'kin-01' } }, hosted), {
    code: 'instance_scope_conflict',
  })
  assert.equal(
    slotContainerForVm({ id: 'vm-01', runtime: { container: slotContainerName('vm-01', hosted) } }, hosted),
    slotContainerName('vm-01', hosted),
  )
})

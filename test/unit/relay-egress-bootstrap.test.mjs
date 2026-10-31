import assert from 'node:assert/strict'
import test from 'node:test'
import { relayEgressAction } from '../../integrations/reclaude/ensure-egress.mjs'

const proxy = { enabled: false, bound_vm_ids: [] }
const policy = { required: true, expected_ip: '192.0.2.1', revision: 'pinned' }
const action = (state, nextProxy = proxy, nextPolicy = policy) =>
  relayEgressAction(nextProxy, nextPolicy, state, '192.0.2.1')

test('relay bootstrap restarts only the native dead helper under the existing pin', () => {
  assert.equal(action({ reason: 'exit_guard_not_running', latched: false }), 'start')
  for (const reason of ['verified', 'exit_guard_checking', 'exit_guard_retrying']) {
    assert.equal(action({ reason, ready: reason === 'verified' }), 'observe')
  }
})

test('relay bootstrap cannot accept a new exit or clear a latch', () => {
  assert.throws(() => action({ reason: 'exit_guard_not_running', latched: true }), /latched/)
  assert.throws(() => action({}, proxy, { ...policy, expected_ip: '192.0.2.2' }), /policy changed/)
  assert.throws(() => action({}, proxy, { ...policy, required: false }), /policy changed/)
  assert.throws(() => action({}, proxy, { ...policy, revision: '' }), /policy changed/)
  for (const reason of ['exit_guard_stale', 'exit_guard_unverified', 'exit_ip_mismatch', 'exit_ip_probe_failed']) {
    assert.throws(() => action({ reason }), /operator review/)
  }
})

test('relay bootstrap refuses a proxy allocated to ordinary slots', () => {
  for (const value of [null, { enabled: true }, { bound_vm_id: 'slot' }, { bound_vm_ids: ['slot'] }]) {
    assert.throws(() => action({ ready: true }, value), /reserved/)
  }
})

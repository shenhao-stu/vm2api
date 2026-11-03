import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { scopedRemoteHost, nativeServiceLabel } from '../../src/lib/vm/instance-scope.mjs'
import { bindPlacement, unbindPlacement } from '../../src/lib/cluster/placement.mjs'
import {
  nativeSlotPaths,
  nativeServicePlists,
  stopNativeSlot,
  destroyNativeSlot,
} from '../../src/lib/cluster/native-slot.mjs'

// Observe actual commands selected by lifecycle code; no shell or launchd runs.
test('shared native login stops and deletes only its instance labels and slot tree', async (t) => {
  const previous = process.env.VM2API_INSTANCE_ID
  t.after(() => {
    unbindPlacement()
    if (previous === undefined) delete process.env.VM2API_INSTANCE_ID
    else process.env.VM2API_INSTANCE_ID = previous
  })
  const results = []
  for (const instance of ['', 'hosted', 'second']) {
    process.env.VM2API_INSTANCE_ID = instance
    const commands = []
    const client = {
      exec(command, callback) {
        commands.push(command)
        const stream = new EventEmitter()
        stream.stderr = new EventEmitter()
        stream.close = () => stream.emit('close')
        callback(null, stream)
        queueMicrotask(() => {
          const output = command.includes('u=$(id -u)')
            ? 'gui/501\n'
            : command.startsWith('launchctl print ')
              ? '\tstate = running\n\tpid = 101\n'
              : ''
          stream.emit('data', output)
          stream.emit('exit', 0)
          stream.emit('close')
        })
      },
    }
    const host = scopedRemoteHost({ root: '/Users/u/.vm2api', uid: 501, gid: 20, platform: 'darwin' })
    bindPlacement({
      manager: { client: () => client, remoteHost: async () => host, dropSlotRelays: async () => {} },
      projectRoot: '/unused',
    })
    const vm = {
      id: 'vm-01',
      node_id: 'native',
      runtime: { remote_dir: `${host.root}/vms/vm-01`, launchd: { kernel: nativeServiceLabel('vm-01') } },
    }
    const p = nativeSlotPaths(host.root, vm.id, 'digest')
    const plist = nativeServicePlists(vm, p).kernel
    assert.equal(plist.label, vm.runtime.launchd.kernel)
    assert.ok(plist.body.includes(`${host.root}/vms/vm-01/cli-home`))
    assert.equal((await stopNativeSlot(vm)).ok, true)
    assert.equal((await destroyNativeSlot(vm)).ok, true)
    assert.ok(commands.some((command) => command.includes(nativeServiceLabel(vm.id, 'telemetry'))))
    assert.ok(commands.some((command) => command.includes(`${host.root}/vms/vm-01`)))
    if (instance) {
      assert.equal(
        commands.some((command) => command.includes('com.vm2api.slot.vm-01')),
        false,
      )
      const count = commands.length
      const foreign = structuredClone(vm)
      foreign.runtime.remote_dir = '/Users/u/.vm2api/vms/vm-01'
      assert.equal((await stopNativeSlot(foreign)).code, 'instance_scope_conflict')
      assert.equal((await destroyNativeSlot(foreign)).code, 'instance_scope_conflict')
      assert.equal(commands.length, count, 'foreign runtime must be refused before SSH mutation')
    }
    results.push({ root: host.root, label: plist.label })
  }
  assert.equal(new Set(results.map((result) => result.root)).size, 3)
  assert.equal(new Set(results.map((result) => result.label)).size, 3)
})

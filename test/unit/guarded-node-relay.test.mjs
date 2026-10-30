import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createGuardedNodeRelay, guardedNodePort } from '../../src/lib/cluster/guarded-node-relay.mjs'

function fixture() {
  const client = new EventEmitter()
  const forwards = [],
    removed = [],
    sockets = []
  client.forwardIn = (host, port, cb) => {
    forwards.push({ host, port })
    cb(null, port)
  }
  client.unforwardIn = (host, port, cb) => {
    removed.push({ host, port })
    cb?.()
  }
  let allowed = true
  const relay = createGuardedNodeRelay(client, {
    targetFor: () => {
      if (!allowed) throw new Error('exit_ip_mismatch')
      return 'socks5h://127.0.0.1:45678'
    },
    connect: (target) => {
      const s = new PassThrough()
      s.target = target
      sockets.push(s)
      return s
    },
  })
  return {
    client,
    relay,
    forwards,
    removed,
    sockets,
    deny: () => {
      allowed = false
    },
  }
}

test('one loopback listener per slot; repeated preparation is idempotent', async () => {
  const f = fixture()
  const [a, b] = await Promise.all([f.relay.ensure('slot-a', 'px-a'), f.relay.ensure('slot-a', 'px-a')])
  assert.equal(a, b)
  assert.equal(a, `socks5h://127.0.0.1:${guardedNodePort('slot-a')}`)
  assert.deepEqual(f.forwards, [{ host: '127.0.0.1', port: guardedNodePort('slot-a') }])
  assert.notEqual(guardedNodePort('slot-a'), guardedNodePort('slot-b'))
  f.client.emit('close')
})

test('unverified guard opens no listener and never falls back to the raw proxy', async () => {
  const f = fixture()
  f.deny()
  await assert.rejects(f.relay.ensure('slot-a', 'px-a'), /exit_ip_mismatch/)
  assert.equal(f.forwards.length, 0)
  f.client.emit('close')
})

test('guard is checked on every channel; unexpected listeners and non-loopback peers are rejected', async () => {
  const f = fixture()
  await f.relay.ensure('slot-a', 'px-a')
  let accepted = 0,
    rejected = 0
  const request = (overrides = {}) =>
    f.client.emit(
      'tcp connection',
      {
        destIP: '127.0.0.1',
        destPort: guardedNodePort('slot-a'),
        srcIP: '127.0.0.1',
        ...overrides,
      },
      () => {
        accepted++
        return new PassThrough()
      },
      () => {
        rejected++
      },
    )
  request({ destPort: 1 })
  request({ srcIP: '192.0.2.1' })
  request({ destIP: '0.0.0.0' })
  assert.equal(accepted, 0)
  assert.equal(rejected, 3)
  request()
  assert.equal(accepted, 1)
  assert.deepEqual(f.sockets[0].target, { host: '127.0.0.1', port: 45678 })
  f.deny()
  request()
  assert.equal(accepted, 1)
  assert.equal(rejected, 4)
  f.client.emit('close')
  assert.equal(f.sockets[0].destroyed, true)
})

test('release closes streams and listener; a new client restores the same port', async () => {
  const f = fixture()
  const url = await f.relay.ensure('slot-a', 'px-a')
  await f.relay.release('slot-a')
  assert.equal(f.removed.length, 1)
  f.client.emit('close')
  const g = fixture()
  assert.equal(await g.relay.ensure('slot-a', 'px-a'), url)
  g.client.emit('close')
})

test('forwarding failures fail closed and can be retried without accepting stale endpoints', async () => {
  const f = fixture()
  f.client.forwardIn = (_host, _port, cb) => cb(new Error('port already occupied'))
  await assert.rejects(f.relay.ensure('slot-a', 'px-a'), /port already occupied/)
  f.client.forwardIn = (_host, port, cb) => cb(null, port)
  await f.relay.ensure('slot-a', 'px-a')
  await assert.rejects(f.relay.ensure('slot-a', 'px-b'), /binding_changed/)
  f.client.emit('close')
})

test('only a loopback guarded SOCKS endpoint may be relayed', async () => {
  for (const target of ['socks5h://192.0.2.1:1', 'http://127.0.0.1:1', 'socks5h://user:secret@127.0.0.1:1', '']) {
    const client = new EventEmitter()
    let opened = 0
    client.forwardIn = () => {
      opened++
    }
    const relay = createGuardedNodeRelay(client, { targetFor: () => target })
    await assert.rejects(relay.ensure('slot-a', 'px-a'), /invalid_guard_listener/)
    assert.equal(opened, 0)
    client.emit('close')
  }
})

import crypto from 'node:crypto'
import net from 'node:net'
import { guardedProxyUrl } from '../vm/proxy-exit-guard.mjs'

// A stable port lets an unchanged helper reconnect after the SSH link recovers.
export function guardedNodePort(vmId) {
  return 30000 + (crypto.createHash('sha256').update(String(vmId)).digest().readUInt32BE(0) % 30000)
}

function guardTarget(url) {
  const match = /^socks5h:\/\/127\.0\.0\.1:([0-9]+)$/.exec(url || '')
  const port = Number(match?.[1])
  if (!match || port < 1 || port > 65535) throw new Error('invalid_guard_listener')
  return { host: '127.0.0.1', port }
}

/** The node receives only a loopback SSH forward to the control host's enforcing guard. */
export function createGuardedNodeRelay(client, { targetFor, connect = (target) => net.connect(target) }) {
  const slots = new Map(),
    ports = new Map()
  let closed = false
  const target = (entry) => guardTarget(targetFor(entry.proxyId))
  const forget = (entry) => {
    if (slots.get(entry.vmId) === entry) slots.delete(entry.vmId)
    if (ports.get(entry.port) === entry) ports.delete(entry.port)
    for (const stream of entry.streams) stream.destroy()
  }
  const onConnection = (info, accept, reject) => {
    const entry = ports.get(info.destPort)
    if (closed || !entry?.ready || info.destIP !== '127.0.0.1' || info.srcIP !== '127.0.0.1') return reject()
    let socket, channel
    try {
      const endpoint = target(entry)
      if (entry.streams.size >= 256) return reject()
      channel = accept()
      socket = connect(endpoint)
    } catch {
      if (channel) channel.destroy()
      else reject()
      return
    }
    for (const stream of [socket, channel]) {
      entry.streams.add(stream)
      stream.once('close', () => {
        entry.streams.delete(stream)
        socket.destroy()
        channel.destroy()
      })
      stream.on('error', () => {
        socket.destroy()
        channel.destroy()
      })
    }
    socket.setTimeout?.(10_000, () => socket.destroy())
    socket.once('connect', () => socket.setTimeout?.(0))
    socket.pipe(channel)
    channel.pipe(socket)
  }
  client.on('tcp connection', onConnection)
  client.once('close', () => {
    closed = true
    client.off('tcp connection', onConnection)
    for (const entry of slots.values()) {
      entry.abort?.()
      forget(entry)
    }
  })

  return {
    async ensure(vmId, proxyId) {
      if (closed) throw new Error('guarded_node_link_closed')
      const previous = slots.get(vmId)
      if (previous && previous.proxyId !== proxyId) throw new Error('guarded_node_binding_changed')
      target({ proxyId })
      if (previous) return previous.promise
      const port = guardedNodePort(vmId)
      if (ports.has(port)) throw new Error('guarded_node_port_collision')
      const entry = { vmId, proxyId, port, ready: false, streams: new Set() }
      slots.set(vmId, entry)
      ports.set(port, entry)
      entry.promise = new Promise((resolve, reject) => {
        let settled = false
        const fail = (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          forget(entry)
          reject(err)
        }
        const timer = setTimeout(() => fail(new Error('guarded_node_forward_timeout')), 10_000)
        entry.abort = () => fail(new Error('guarded_node_link_closed'))
        const forwarded = (err, boundPort) => {
          if (settled) {
            if (!err && !closed) client.unforwardIn('127.0.0.1', port, () => {})
            return
          }
          if (err) return fail(err)
          if (boundPort !== port) {
            client.unforwardIn('127.0.0.1', boundPort, () => {})
            return fail(new Error('guarded_node_listener_changed'))
          }
          settled = true
          clearTimeout(timer)
          entry.ready = true
          resolve(`socks5h://127.0.0.1:${port}`)
        }
        try {
          client.forwardIn('127.0.0.1', port, forwarded)
        } catch (error) {
          fail(error)
        }
      })
      return entry.promise
    },
    async release(vmId) {
      const entry = slots.get(vmId)
      if (!entry) return
      entry.abort?.()
      forget(entry)
      if (!closed) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 5_000)
          try {
            client.unforwardIn('127.0.0.1', entry.port, () => {
              clearTimeout(timer)
              resolve()
            })
          } catch {
            clearTimeout(timer)
            resolve()
          }
        })
      }
    },
  }
}

const relays = new WeakMap()

export async function ensureGuardedNodeProxy(client, vm, projectRoot) {
  let relay = relays.get(client)
  if (!relay) {
    relay = createGuardedNodeRelay(client, {
      targetFor: (proxyId) => guardedProxyUrl(projectRoot, { id: proxyId }),
    })
    relays.set(client, relay)
  }
  return relay.ensure(vm.id, vm.proxy.id)
}

export async function releaseGuardedNodeProxy(client, vmId) {
  await relays.get(client)?.release(vmId)
}

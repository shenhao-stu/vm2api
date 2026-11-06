import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { servePoolSeatStream } from '../../src/lib/admin/pool-seat-stream.mjs'

function fixture(t, options = {}) {
  const req = new EventEmitter()
  const res = new EventEmitter()
  const scheduler = new EventEmitter()
  const frames = []
  let seats = 0
  res.blocked = false
  res.write = (frame) => {
    frames.push(frame)
    return !res.blocked
  }
  res.destroy = () => {
    res.destroyed = true
    res.emit('close')
  }
  scheduler.seatSnapshot = () => ({ seats: { account: { used: seats } }, global_queue_depth: 0, queue_max: 50 })
  servePoolSeatStream({ req, res, getScheduler: () => scheduler, writeSSEHeaders() {}, throttleMs: 1, ...options })
  t.after(() => res.emit('close'))
  return {
    res,
    frames,
    scheduler,
    set: (used) => {
      seats = used
      scheduler.emit('change')
    },
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

test('unchanged panel snapshots do not resend full state', async (t) => {
  const f = fixture(t)
  f.set(0)
  await tick()
  assert.equal(f.frames.length, 1)
  f.set(1)
  await tick()
  assert.equal(f.frames.length, 2)
})

test('a slow panel consumer holds only latest dirty state and releases listeners on close', async (t) => {
  const f = fixture(t)
  f.res.blocked = true
  f.set(1)
  await tick()
  for (let used = 2; used <= 100; used++) f.set(used)
  await tick()
  assert.equal(f.frames.length, 2)
  f.res.blocked = false
  f.res.emit('drain')
  assert.equal(f.frames.length, 3)
  assert.equal(JSON.parse(f.frames[2].split('data: ')[1]).seats.account.used, 100)
  f.res.emit('close')
  assert.equal(f.res.listenerCount('drain'), 0)
  assert.equal(f.scheduler.listenerCount('change'), 0)
})

test('a panel consumer that never drains is disconnected', async (t) => {
  const f = fixture(t, { drainTimeoutMs: 5 })
  f.res.blocked = true
  f.set(1)
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(f.res.destroyed, true)
  assert.equal(f.scheduler.listenerCount('change'), 0)
})

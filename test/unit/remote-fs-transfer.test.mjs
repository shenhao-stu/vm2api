import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { writeRemoteFile } from '../../src/lib/cluster/remote-fs.mjs'

class Sftp extends EventEmitter {
  active = 0
  peak = 0
  renamed = false
  bytes = Buffer.alloc(512 * 1024)
  open(_path, flags, _attrs, cb) {
    assert.equal(flags, 'wx')
    cb(null, Buffer.from('handle'))
  }
  write(_handle, data, offset, length, position, cb) {
    this.peak = Math.max(this.peak, ++this.active)
    setTimeout(
      () => {
        data.copy(this.bytes, position, offset, offset + length)
        this.active--
        cb(null)
      },
      (position % 3) + 2,
    )
  }
  fchmod(_handle, mode, cb) {
    this.mode = mode
    cb(null)
  }
  fchown(_handle, uid, gid, cb) {
    this.owner = { uid, gid }
    cb(null)
  }
  close(_handle, cb) {
    assert.equal(this.active, 0)
    cb(null)
  }
  unlink(_path, cb) {
    cb(null)
  }
  ext_openssh_rename(_from, _to, cb) {
    assert.equal(this.active, 0)
    this.renamed = true
    cb(null)
  }
}

test('large uploads pipeline bounded writes and retain byte offsets and permissions', async () => {
  const sftp = new Sftp()
  const bytes = Buffer.from('出口🙂'.repeat(40000))
  await writeRemoteFile(sftp, '/slot/binary', bytes, { mode: 0o755, owner: { uid: 1000, gid: 1000 } })
  assert.ok(sftp.peak > 1, 'one RTT per 32 KiB serializes a large upload')
  assert.ok(sftp.peak <= 8)
  assert.deepEqual(sftp.bytes.subarray(0, bytes.length), bytes)
  assert.equal(sftp.mode, 0o755)
  assert.deepEqual(sftp.owner, { uid: 1000, gid: 1000 })
  assert.equal(sftp.renamed, true)
  assert.equal(sftp.listenerCount('close'), 0)
  assert.equal(sftp.listenerCount('error'), 0)
})

test('channel close without a write callback rejects instead of hanging after reconnect', async () => {
  const sftp = new Sftp()
  sftp.write = () => queueMicrotask(() => sftp.emit('close'))
  const result = await Promise.race([
    writeRemoteFile(sftp, '/slot/binary', 'payload').then(
      () => 'written',
      (e) => e,
    ),
    delay(100).then(() => 'hung'),
  ])
  assert.ok(result instanceof Error, String(result))
  assert.equal(result.code, 'sftp_failed')
  assert.equal(sftp.renamed, false)
  assert.equal(sftp.listenerCount('close'), 0)
})

test('a silent SFTP request has a deadline and cannot publish partial data', async () => {
  const sftp = new Sftp()
  sftp.write = () => {}
  const result = await Promise.race([
    writeRemoteFile(sftp, '/slot/binary', 'payload', { timeoutMs: 15 }).then(
      () => 'written',
      (e) => e,
    ),
    delay(100).then(() => 'hung'),
  ])
  assert.ok(result instanceof Error, String(result))
  assert.equal(result.code, 'sftp_failed')
  assert.equal(sftp.renamed, false)
})

test('cleanup on a dead channel is bounded and preserves the original transfer error', async () => {
  const sftp = new Sftp()
  sftp.write = (...args) => args.at(-1)(new Error('No response from server'))
  sftp.close = () => {}
  sftp.unlink = () => {}
  const result = await Promise.race([
    writeRemoteFile(sftp, '/slot/binary', 'payload', { timeoutMs: 10 }).catch((error) => error),
    delay(100).then(() => 'cleanup hung'),
  ])
  assert.ok(result instanceof Error, String(result))
  assert.match(result.message, /No response from server/)
  assert.equal(sftp.renamed, false)
})

test('one failed write waits for its siblings before closing and never renames', async () => {
  const sftp = new Sftp()
  const normal = sftp.write.bind(sftp)
  sftp.write = (h, data, offset, length, position, cb) => {
    if (position === 32768) return cb(new Error('write failed'))
    normal(h, data, offset, length, position, cb)
  }
  await assert.rejects(writeRemoteFile(sftp, '/slot/binary', Buffer.alloc(512 * 1024)), /write failed/)
  assert.equal(sftp.active, 0)
  assert.equal(sftp.renamed, false)
  assert.equal(sftp.listenerCount('close'), 0)
})

test('concurrent files share channel failure listeners without accumulating handlers', async () => {
  const sftp = new Sftp()
  sftp.close = (_handle, cb) => cb(null)
  sftp.ext_openssh_rename = (_from, _to, cb) => cb(null)
  let listeners = 0
  const normal = sftp.write.bind(sftp)
  sftp.write = (...args) => {
    listeners = Math.max(listeners, sftp.listenerCount('close'))
    normal(...args)
  }
  await Promise.all([0, 1, 2].map((i) => writeRemoteFile(sftp, `/slot/file-${i}`, Buffer.alloc(512 * 1024))))
  assert.equal(listeners, 1)
  assert.equal(sftp.active, 0)
  assert.equal(sftp.listenerCount('close'), 0)
  assert.equal(sftp.listenerCount('error'), 0)
})

test('a late callback from a timed-out request cannot detach a newer upload', async () => {
  const sftp = new Sftp()
  const normal = sftp.write.bind(sftp)
  let lateReply
  sftp.write = (...args) => {
    lateReply = args.at(-1)
  }
  await assert.rejects(writeRemoteFile(sftp, '/slot/expired', 'x', { timeoutMs: 5 }), /timed out/)
  sftp.write = normal
  sftp.close = (_handle, cb) => cb(null)
  sftp.ext_openssh_rename = (_from, _to, cb) => cb(null)
  const second = writeRemoteFile(sftp, '/slot/new', Buffer.alloc(256 * 1024))
  await Promise.resolve()
  lateReply(null)
  const third = writeRemoteFile(sftp, '/slot/other', Buffer.alloc(256 * 1024))
  await Promise.resolve()
  try {
    assert.equal(sftp.listenerCount('close'), 1)
  } finally {
    await Promise.all([second, third])
  }
  assert.equal(sftp.listenerCount('close'), 0)
})

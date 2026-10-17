import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { PanelUserStore, hashPassword, verifyPassword, publicUserView } from '../../src/lib/admin/panel-users.mjs'

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-users-'))
  const db = createDatabase({ dataDir: dir })
  return { dir, db, store: new PanelUserStore({ db }) }
}

test('scrypt hash verifies and is not reversible', () => {
  const hashed = hashPassword('correct-horse')
  assert.match(hashed, /^scrypt\$/)
  assert.equal(verifyPassword('correct-horse', hashed), true)
  assert.equal(verifyPassword('wrong-pass', hashed), false)
  assert.doesNotMatch(hashed, /correct-horse/)
})

test('bootstrap seeds env admin once', () => {
  const { store } = tmpStore()
  const first = store.bootstrapFromEnv({ username: 'admin', password: 'testpass1' })
  const second = store.bootstrapFromEnv({ username: 'admin', password: 'otherpass' })
  assert.equal(first.username, 'admin')
  assert.equal(first.role, 'admin')
  assert.equal(second.id, first.id)
  assert.ok(store.authenticate('admin', 'testpass1'))
  assert.equal(store.authenticate('admin', 'otherpass'), null)
})

test('bootstrap imports legacy env passwords without relaxing user password validation', () => {
  const { store } = tmpStore()
  for (const [username, password] of [
    ['admin', '123456'],
    ['legacy', 'short'],
  ]) {
    const admin = store.bootstrapFromEnv({ username, password })
    assert.equal(admin.role, 'admin')
    assert.equal(admin.enabled, true)
    assert.equal(admin.password_hash, undefined)
    assert.ok(store.list().some((user) => user.id === admin.id))
    assert.ok(store.authenticate(username, password))
    assert.notEqual(store.getById(admin.id).password_hash, password)
    assert.throws(() => store.update(admin.id, { password: 'short' }), /密码至少 8 位/)

    store.update(admin.id, { password: 'changed-admin-pass' })
    const again = store.bootstrapFromEnv({ username, password })
    assert.equal(again.id, admin.id)
    assert.equal(store.authenticate(username, password), null)
    assert.ok(store.authenticate(username, 'changed-admin-pass'))
  }
  assert.throws(() => store.create({ username: 'reader', password: '123456' }), /密码至少 8 位/)
})

test('bootstrap preserves disabled admins and validates usernames', () => {
  const { store } = tmpStore()
  store.create({ username: 'owner', password: 'owner-pass', role: 'admin' })
  const admin = store.create({ username: 'admin', password: 'admin-pass', role: 'admin', enabled: false })
  const imported = store.bootstrapFromEnv({ username: 'admin', password: '123456' })
  assert.equal(imported.id, admin.id)
  assert.equal(imported.enabled, false)
  assert.equal(store.authenticate('admin', '123456'), null)
  assert.equal(store.bootstrapFromEnv({ username: 'empty', password: '' }), null)
  assert.throws(() => store.bootstrapFromEnv({ username: '1bad', password: '123456' }), /用户名/)
})

test('create / authenticate / change password / roles', () => {
  const { store } = tmpStore()
  store.bootstrapFromEnv({ username: 'admin', password: 'adminpass' })
  const viewer = store.create({ username: 'reader', password: 'reader-pass', role: 'user' })
  const superu = store.create({ username: 'ops', password: 'super-pass', role: 'super' })
  assert.equal(viewer.role, 'user')
  assert.equal(superu.role, 'super')
  assert.equal(store.authenticate('reader', 'reader-pass').role, 'user')
  assert.equal(store.authenticate('ops', 'wrong-pass'), null)

  const updated = store.update(viewer.id, { password: 'reader-next' })
  assert.equal(store.authenticate('reader', 'reader-pass'), null)
  assert.ok(store.authenticate('reader', 'reader-next'))
  assert.equal(publicUserView(updated).password_hash, undefined)
})

test('cannot remove or demote the last admin', () => {
  const { store } = tmpStore()
  const admin = store.create({ username: 'admin', password: 'adminpass', role: 'admin' })
  assert.throws(() => store.update(admin.id, { role: 'user' }), /最后一个管理员/)
  assert.throws(() => store.update(admin.id, { enabled: false }), /最后一个管理员/)
  assert.throws(() => store.remove(admin.id), /最后一个管理员/)
})

test('rejects bad username / short password / unknown role', () => {
  const { store } = tmpStore()
  assert.throws(() => store.create({ username: '1bad', password: 'longenough', role: 'user' }), /用户名/)
  assert.throws(() => store.create({ username: 'okuser', password: 'short', role: 'user' }), /密码/)
  assert.throws(() => store.create({ username: 'okuser', password: 'longenough', role: 'root' }), /角色/)
})

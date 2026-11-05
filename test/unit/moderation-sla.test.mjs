import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { SLA_ERROR_PRED, SLA_SUCCESS_PRED } from '../../src/lib/db/repos/usage-log-preds.mjs'

test('moderation outage is an SLA failure, including historical rows; a real policy rejection remains excluded', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE usage_logs (status INTEGER, error_code TEXT, error_message TEXT)')
    const add = db.prepare('INSERT INTO usage_logs VALUES (?, ?, ?)')
    add.run(503, 'moderation_unavailable', '决策模型不可用')
    add.run(403, 'policy_blocked', '请求被协议拦截: 决策模型不可用（上游 403）')
    add.run(403, 'policy_blocked', '请求被协议拦截: usage_policy')
    add.run(200, null, null)
    add.run(401, 'invalid_api_key', 'Invalid credentials')
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM usage_logs WHERE ${SLA_ERROR_PRED}`).get().n, 2)
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM usage_logs WHERE ${SLA_SUCCESS_PRED}`).get().n, 3)
  } finally {
    db.close()
  }
})

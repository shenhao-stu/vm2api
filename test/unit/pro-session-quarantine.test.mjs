import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ProSessionQuarantineRepo } from '../../src/lib/db/repos/pro-session-quarantine-repo.mjs'
import { createProSessionQuarantine, confirmedProRefusal } from '../../src/lib/core/pro-session-quarantine.mjs'

const refusal = { type: 'message_delta', delta: { stop_reason: 'refusal' } }
const user = (content) => ({ role: 'user', content })
const old = [
  user('synthetic first turn'),
  { role: 'assistant', content: 'earlier response' },
  user('synthetic refused turn'),
]
const continuation = [...old, { role: 'assistant', content: 'prior terminal' }, user('Continue')]
function fixture(t) {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const repo = new ProSessionQuarantineRepo(db)
  const options = new Map()
  const guard = (sid, messages, key = 'slot-a', device = 'device-a') =>
    createProSessionQuarantine({
      req: { apiKeyKind: 'managed', apiKeyRecord: { id: key } },
      inbound: { metadata: sid ? { user_id: JSON.stringify({ session_id: sid, device_id: device }) } : {}, messages },
      repo,
      settings: { get: (k, fallback) => options.get(k) ?? fallback },
    })
  return { db, options, guard }
}

test('official Pro refusal isolates the continuation, without attaching the ban to the device', (t) => {
  const { guard, db, options } = fixture(t)
  const original = guard('s1', old)
  assert.equal(original.blocked(), false)
  assert.equal(original.observe(refusal), true)
  assert.equal(original.observe({ body: { stop_reason: 'refusal' } }), true)
  assert.equal(guard('s1', [user('Continue')]).blocked(), true)
  assert.equal(guard('fresh', [user('ordinary question')]).blocked(), false)
  assert.equal(guard('s1', [user('Continue')], 'unrelated-key').blocked(), false)
  const rows = db.prepare('SELECT * FROM pro_session_quarantines').all()
  assert.equal(rows.length, 2)
  assert.ok(!JSON.stringify(rows).includes('synthetic') && !JSON.stringify(rows).includes('device-a'))
  options.set('pro_session_quarantine_enabled', false)
  assert.equal(original.blocked(), false)
  assert.equal(guard('new', [user('new')]).observe(refusal), false)
  options.set('pro_session_quarantine_enabled', true)
  assert.equal(original.blocked(), true)
  assert.equal(guard('new', [user('new')]).blocked(), false)
})

test('only approved rotation keys share a namespace; copied refused history is recognized without a session ID', (t) => {
  const { guard, options } = fixture(t)
  options.set('pro_session_quarantine_key_namespaces', { 'slot-a': 'pool', 'slot-b': 'pool' })
  assert.equal(guard('s1', old).observe(refusal), true)
  assert.equal(guard('s1', [user('Continue')], 'slot-b').blocked(), true)
  assert.equal(guard('', continuation, 'slot-b').blocked(), true)
  assert.equal(guard('s2', continuation, 'slot-b', 'device-a').blocked(), true)
  assert.equal(guard('s2', continuation, 'slot-b', 'unrelated-device').blocked(), false)
  assert.equal(guard('fresh', old, 'slot-b').blocked(), false)
  assert.equal(guard('s2', [user('fresh')], 'slot-b', 'new-device').blocked(), false)
  assert.equal(guard('', continuation, 'external').blocked(), false)
  const changed = [...old.slice(0, -1), user('different turn'), user('Continue')]
  assert.equal(guard('', changed, 'slot-b').blocked(), false)
})

test('anonymous history matches a continued final user block regardless of cache annotations or object key order', (t) => {
  const { guard } = fixture(t)
  const block = { type: 'text', text: 'synthetic refused turn', cache_control: { type: 'ephemeral' } }
  const first = [...old.slice(0, -1), user([block])]
  guard('', first).observe(refusal)
  assert.equal(
    guard('', [
      ...old.slice(0, -1),
      user([
        { text: block.text, type: 'text' },
        { type: 'text', text: 'Continue' },
      ]),
    ]).blocked(),
    true,
  )
  assert.equal(guard('', [user('Continue')]).blocked(), false)
})

test('only provider refusal signals qualify; ordinary assistant text and infrastructure errors remain ordinary', () => {
  for (const v of [
    refusal,
    { body: { stop_reason: 'refusal' } },
    { type: 'content_block_start', content_block: { type: 'refusal', refusal: 'blocked' } },
    { type: 'error', error: { type: 'invalid_request_error', code: 'usage_policy' } },
    {
      status: 400,
      body: {
        error: {
          type: 'invalid_request_error',
          message:
            'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy.',
        },
      },
    },
  ])
    assert.equal(confirmedProRefusal(v), true)
  for (const v of [
    null,
    { status: 429, body: { error: { type: 'rate_limit_error', code: 'usage_policy' } } },
    { status: 401, body: { error: { type: 'authentication_error', message: 'usage policy' } } },
    { status: 502, body: { error: { message: 'Connection error' } } },
    { code: 'refusal_guard' },
    { body: { content: [{ type: 'text', text: 'I cannot help with that' }], stop_reason: 'end_turn' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Usage Policy' } },
    { type: 'error', error: { type: 'invalid_request_error', message: 'example field mentions Usage Policy' } },
    { type: 'error', error: { type: 'policy_error', code: 'refusal_guard' } },
  ])
    assert.equal(confirmedProRefusal(v), false)
})

test('an in-process refusal remains effective through a transient SQLite write failure', (t) => {
  const { guard, db } = fixture(t)
  db.exec(
    "CREATE TRIGGER reject_quarantine BEFORE INSERT ON pro_session_quarantines BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END",
  )
  assert.equal(guard('s1', old).observe(refusal), true)
  assert.equal(guard('s1', [user('Continue')]).blocked(), true)
  assert.equal(guard('', continuation).blocked(), true)
  assert.equal(guard('another', [user('unrelated')]).blocked(), false)
  assert.equal(db.prepare('SELECT count(*) n FROM pro_session_quarantines').get().n, 0)
  db.exec('DROP TRIGGER reject_quarantine')
  guard('s2', [user('another synthetic refusal')]).observe(refusal)
  const recovered = new ProSessionQuarantineRepo(db)
  assert.equal(
    createProSessionQuarantine({
      req: { apiKeyRecord: { id: 'slot-a' } },
      inbound: { messages: continuation },
      settings: { get: (_key, fallback) => fallback },
      repo: recovered,
    }).blocked(),
    true,
  )
})

test('verified namespaces do not take authority from caller headers or join different key owners', (t) => {
  const { db } = fixture(t)
  const config = { get: (k, d) => (k === 'pro_session_quarantine_key_namespaces' ? { a: 'pool', b: 'pool' } : d) }
  const check = (key, owner, headers = {}) =>
    createProSessionQuarantine({
      req: { apiKeyRecord: { id: key, user_id: owner } },
      headers,
      inbound: { metadata: { user_id: '{"session_id":"collision","device_id":"same"}' }, messages: old },
      settings: config,
      repo: new ProSessionQuarantineRepo(db),
    })
  assert.equal(check('a', 10).observe(refusal), true)
  assert.equal(check('b', 11).blocked(), false)
  assert.equal(check('other', 10, { 'x-getoken-user-id': '10', 'x-slot-namespace': 'pool' }).blocked(), false)
  assert.equal(check('b', 10).blocked(), true)
})

test('shared prompt cache keys and malformed identities never lock a different conversation', (t) => {
  const { db } = fixture(t)
  const repo = new ProSessionQuarantineRepo(db)
  const check = (extra, messages) =>
    createProSessionQuarantine({
      req: { apiKeyRecord: { id: 'key' } },
      inbound: { prompt_cache_key: 'product/static-prompt', ...extra, messages },
      settings: { get: (_k, d) => d },
      repo,
    })
  for (const extra of [{}, { metadata: { user_id: { session_id: { synthetic: true } } } }]) {
    assert.equal(check(extra, old).observe(refusal), true)
    assert.equal(check(extra, [user('unrelated request')]).blocked(), false)
    assert.equal(check(extra, continuation).blocked(), true)
  }
})

test('anonymous converted Chat histories retain tool arguments and results', (t) => {
  const { db } = fixture(t)
  const repo = new ProSessionQuarantineRepo(db)
  const check = (argument, result, follow) =>
    createProSessionQuarantine({
      req: { apiKeyRecord: { id: 'key' } },
      inbound: { messages: [user('check'), { role: 'assistant', content: null }, { role: 'tool', content: result }] },
      body: {
        messages: [
          user('check'),
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1', name: 'read', input: { path: argument } }] },
          user([{ type: 'tool_result', tool_use_id: 'tool_1', content: result }]),
          ...(follow ? [user('Continue')] : []),
        ],
      },
      settings: { get: (_k, d) => d },
      repo,
    })
  assert.equal(check('one', 'first', false).observe(refusal), true)
  assert.equal(check('one', 'first', true).blocked(), true)
  assert.equal(check('two', 'first', true).blocked(), false)
  assert.equal(check('one', 'other', true).blocked(), false)
})

test('a failed SQLite write survives restart, retains the first refusal and reconciles when writable', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-refusal-journal-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'kin.db')
  const make = (repo, messages, sid = 's1') =>
    createProSessionQuarantine({
      req: { apiKeyRecord: { id: 'k' } },
      inbound: { metadata: { user_id: JSON.stringify({ session_id: sid }) }, messages },
      settings: { get: (_k, d) => d },
      repo,
    })
  let db = createDatabase({ dbPath })
  db.exec(
    "CREATE TRIGGER fail_insert BEFORE INSERT ON pro_session_quarantines BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END",
  )
  assert.equal(make(new ProSessionQuarantineRepo(db), old).observe(refusal), true)
  assert.equal(db.prepare('SELECT count(*) n FROM pro_session_quarantines').get().n, 0)
  db.close()
  db = createDatabase({ dbPath })
  t.after(() => db.close())
  let repo = new ProSessionQuarantineRepo(db)
  assert.equal(make(repo, [user('Continue')]).blocked(), true)
  assert.equal(make(repo, [user('unrelated')], 'new').blocked(), false)
  const files = fs.readdirSync(`${dbPath}.pro-refusal-pending`).filter((name) => name.endsWith('.json'))
  assert.ok(files.length > 0)
  const file = path.join(`${dbPath}.pro-refusal-pending`, files[0])
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.readFileSync(file, 'utf8').includes('synthetic first turn'), false)
  db.exec('DROP TRIGGER fail_insert')
  repo = new ProSessionQuarantineRepo(db)
  assert.equal(make(repo, [user('Continue')]).blocked(), true)
  assert.equal(db.prepare('SELECT count(*) n FROM pro_session_quarantines').get().n, 2)
  assert.deepEqual(fs.readdirSync(`${dbPath}.pro-refusal-pending`), [])
  fs.writeFileSync(file, '{}')
  assert.throws(() => new ProSessionQuarantineRepo(db), /journal digest/)
})

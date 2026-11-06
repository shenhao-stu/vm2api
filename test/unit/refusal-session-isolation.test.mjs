import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { RefusedSessionsRepo } from '../../src/lib/db/repos/refused-sessions-repo.mjs'
import { createRefusalSessionIsolation } from '../../src/lib/protocol/refusal-session-isolation.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'

const candidate = {
  ok: true,
  vmId: 'pro',
  accountId: 'account',
  vm: { id: 'pro', platform: 'anthropic', claude: { account_tier: 'pro', mode: 'oauth' } },
}
const greeting = { role: 'user', content: 'Hello' }
const answer = { role: 'assistant', content: 'Ready' }
const deniedTurn = { role: 'user', content: 'fixture to be rejected' }
const history = [greeting, answer, deniedTurn]
const continuation = { role: 'user', content: 'continue' }
const result = {
  status: 400,
  body: {
    error: { code: 'upstream_invalid_request', message: 'Unable to respond to this request under our usage policy.' },
  },
}
const model = 'claude-haiku-4-5-20251001'
const dbFixture = (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refusal-isolation-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  let db = createDatabase({ dataDir })
  t.after(() => db.close())
  const policy = { enabled: true, generation: 0 }
  const guard = () =>
    createRefusalSessionIsolation({ readPolicy: () => policy, getRepo: () => new RefusedSessionsRepo(db) })
  return {
    guard,
    policy,
    get db() {
      return db
    },
    restart() {
      db.close()
      db = createDatabase({ dataDir })
    },
  }
}
const request = (factory, sessionId, messages, keyId = 'one') => factory({ keyId, sessionId, messages })
const code = (r, selected = candidate) => r.admit(selected)?.body.error.code ?? null

test('one refusal blocks same session or replayed transcript across restart. A shared greeting or key does not identify the refused context', (t) => {
  const env = dbFixture(t)
  const first = request(env.guard(), 'sid', history)
  assert.equal(code(first), null)
  first.observeLine('data: {"type":"message_delta","delta":{"stop_reason":"refusal"}}')
  const rows = env.db.prepare('select * from refused_sessions').all()
  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => Object.keys(row).length === 1 && /^[0-9a-f]{64}$/.test(row.digest)))
  env.restart()
  const factory = env.guard()
  assert.equal(code(request(factory, 'sid', [continuation])), 'session_context_isolated')
  const replay = [...history.map((m) => ({ content: [{ text: m.content, type: 'text' }], role: m.role })), continuation]
  for (const id of ['', 'new-sid']) assert.equal(code(request(factory, id, replay)), 'session_context_isolated')
  for (const messages of [[continuation], [greeting, answer, continuation]])
    assert.equal(code(request(factory, 'new-sid', messages)), null)
  assert.equal(code(request(factory, 'sid', replay, 'different-key')), null)
  for (const vm of [
    { ...candidate.vm, id: 'hosted-reclaude-01' },
    { ...candidate.vm, claude: { ...candidate.vm.claude, source: 'reclaude' } },
    { ...candidate.vm, claude: { account_tier: 'max' } },
    { ...candidate.vm, platform: 'openai' },
    { ...candidate.vm, claude: { account_tier: 'pro', mode: 'apikey' } },
  ])
    assert.equal(code(request(factory, 'sid', replay), { vm }), null)
})

test('headerless callers replay only the denied prefix. Normal text, auth, quota, billing and local guard results have no isolation effect', (t) => {
  const env = dbFixture(t)
  const factory = env.guard()
  const original = request(factory, '', history)
  assert.equal(code(original), null)
  for (const r of [
    {
      status: 200,
      body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I cannot help due to usage policy' }] },
    },
    { status: 401, body: { error: { message: 'token revoked' } } },
    { status: 429, body: { error: { message: 'over quota' } } },
    { status: 403, body: { error: { message: 'third-party apps now draw from purchased credits' } } },
    { status: 403, body: { error: { code: 'session_context_isolated', message: 'conversation isolated' } } },
    { status: 403, body: { error: { message: 'Organization disabled for a Usage Policy violation' } } },
    { status: 503, body: { error: { message: 'Infrastructure unavailable during Usage Policy update' } } },
    { status: 500, body: { error: { message: 'bad gateway' } } },
  ])
    original.complete(r)
  assert.equal(env.db.prepare('select count(*) as n from refused_sessions').get().n, 0)
  original.complete(result)
  assert.equal(code(request(factory, '', [...history, continuation])), 'session_context_isolated')
  assert.equal(code(request(factory, '', [greeting, answer, continuation])), null)
})

test('disable and re-enable discards a refusal returning from the old generation', (t) => {
  const env = dbFixture(t)
  const factory = env.guard()
  const old = request(factory, 'sid', history)
  assert.equal(code(old), null)
  env.policy.enabled = false
  env.policy.generation++
  assert.equal(code(request(factory, 'sid', [continuation])), null)
  env.policy.enabled = true
  env.policy.generation++
  old.complete(result)
  assert.equal(code(request(factory, 'sid', [continuation])), null)
  assert.equal(env.db.prepare('select count(*) as n from refused_sessions').get().n, 0)
})

test('queued same-session continuation observes the refusal before dispatch and releases both accounts reservations', async (t) => {
  const env = dbFixture(t)
  const factory = env.guard()
  let reservations = 0
  let upstream = 0
  const scheduler = {
    selectAndReserve: async () => {
      reservations++
      return { ...candidate, release: () => reservations-- }
    },
    markSuccess() {},
  }
  const runner = new FailoverRunner({ scheduler })
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  function run(id, messages, callAttempt) {
    const r = request(factory, 'same', messages)
    return runner.run({
      requestId: id,
      model,
      canonicalBody: { model, messages },
      stickyKey: 'same',
      applyAttempt(body, selected) {
        const denial = r.admit(selected)
        return denial ? { localDenial: denial } : body
      },
      callAttempt: async () => {
        upstream++
        return callAttempt()
      },
      onAttempt: ({ result }) => r.complete(result),
    })
  }
  const first = run('first', history, async () => {
    entered.resolve()
    await finish.promise
    return { ...result, ok: false, terminalState: 'rejected' }
  })
  await entered.promise
  const second = run('second', [continuation], () => assert.fail('quarantined session dispatched'))
  finish.resolve()
  const [denied, isolated] = await Promise.all([first, second])
  assert.equal(denied.attemptCount, 1)
  assert.equal(isolated.localDenial.body.error.code, 'session_context_isolated')
  assert.equal(isolated.attemptCount, 0)
  assert.equal(upstream, 1)
  assert.equal(reservations, 0)
})

test('rotating CC billing lines do not make a replay look fresh; changed real system context is distinguishable', (t) => {
  const env = dbFixture(t)
  const factory = env.guard()
  const call = (billing, system) =>
    factory({
      keyId: 'key1',
      system: 'x-anthropic-billing-header: cc_prompt_id=' + billing + ';\n' + system,
      messages: history,
    })
  const first = call('aaa', 'same system')
  assert.equal(code(first), null)
  first.complete(result)
  assert.equal(code(call('bbb', 'same system')), 'session_context_isolated')
  assert.equal(code(call('bbb', 'different system')), null)
})

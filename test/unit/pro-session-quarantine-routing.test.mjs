import test from 'node:test'
import assert from 'node:assert/strict'
import { harness, usage } from '../fixtures/claude-pool-handler.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { RefusalDeviceBlocksRepo } from '../../src/lib/db/repos/refusal-device-blocks-repo.mjs'
import { RefusalGuardsRepo } from '../../src/lib/db/repos/refusal-guards-repo.mjs'
import { ProSessionQuarantineRepo } from '../../src/lib/db/repos/pro-session-quarantine-repo.mjs'
import { handleUserCountTokens } from '../../src/lib/protocol/user-count-tokens.mjs'
import { isClaudeSubscriptionSlot } from '../../src/lib/protocol/pro-session-protection.mjs'
import { refusalFingerprint } from '../../src/lib/core/refusal-guard.mjs'

const device = 'synthetic-test-device'
const original = [{ role: 'user', content: 'Synthetic trigger.' }]
const follow = [...original, { role: 'assistant', content: 'Previous turn.' }, { role: 'user', content: 'Continue' }]

function request(messages, stream, session = 'fixture-conversation') {
  return {
    model: 'claude-opus-5-5',
    messages,
    stream,
    max_tokens: 32,
    metadata: { user_id: JSON.stringify({ device_id: device, session_id: session }) },
  }
}

const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
async function respond(envelope, res, index, { beforeRefusal, afterRefusal, trailerOnly } = {}) {
  const reason = index === 1 ? 'refusal' : 'end_turn'
  res.writeHead(200, { 'content-type': 'text/event-stream', ...(trailerOnly ? { trailer: 'x-stop-reason' } : {}) })
  res.write(
    frame({
      type: 'message_start',
      message: {
        type: 'message',
        role: 'assistant',
        model: envelope.body.model,
        id: 'msg_fixture_' + index,
        content: [],
        usage: { ...usage, output_tokens: 0 },
      },
    }),
  )
  res.write(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  res.write(frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture text' } }))
  res.write(frame({ type: 'content_block_stop', index: 0 }))
  if (reason === 'refusal') await beforeRefusal?.()
  res.write(
    frame({ type: 'message_delta', delta: trailerOnly ? {} : { stop_reason: reason }, usage: { output_tokens: 3 } }),
  )
  if (trailerOnly) {
    res.write(frame({ type: 'message_stop' }))
    await afterRefusal?.()
    res.addTrailers({ 'x-stop-reason': reason })
    return res.end()
  }
  if (reason === 'refusal') await afterRefusal?.()
  res.end(frame({ type: 'message_stop' }))
}

async function fixture(
  t,
  {
    tier = 'pro',
    enabled = true,
    beforeSelect,
    beforeRefusal,
    afterRefusal,
    otherVms,
    selectVm,
    makeQuarantineRepo,
    trailerOnly,
  } = {},
) {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const devices = new RefusalDeviceBlocksRepo(db)
  const guards = new RefusalGuardsRepo(db)
  const receipts = []
  const options = new Map([
    ['pro_session_quarantine_enabled', enabled],
    ['refusal_similarity_enabled', false],
  ])
  const h = await harness(t, true, {
    key: { id: 'test-exclusive-key', group_type: 'all' },
    keys: new Map([['second', { id: 'independent-authenticated-key', group_type: 'all' }]]),
    claude: { mode: 'oauth', account_tier: tier },
    beforeSelect,
    otherVms,
    selectVm,
    respond: (envelope, res, n) => respond(envelope, res, n, { beforeRefusal, afterRefusal, trailerOnly }),
    deps: {
      settings: { get: (k, fallback) => options.get(k) ?? fallback },
      refusalDevices: devices,
      refusalGuards: guards,
      proSessionQuarantineRepo: makeQuarantineRepo?.(db) ?? new ProSessionQuarantineRepo(db),
      apiKeyStore: {
        acquire: () => ({ ok: true }),
        release() {},
        recordUsage: (_key, value) => receipts.push(value),
      },
    },
  })
  return { ...h, options, devices, guards, receipts, db }
}

for (const [tier, stream] of [
  ['pro', false],
  ['pro', true],
  ['max', false],
  ['max', true],
]) {
  test(`${tier} upstream refusal isolates a Continue before a second dispatch, stream=${stream}`, async (t) => {
    const h = await fixture(t, { tier })
    const first = await h.send(request(original, stream))
    assert.equal(first.status, 200, first.text)
    assert.match(first.text, /refusal/)
    assert.equal(h.receipts.length, 1)
    assert.equal(h.receipts[0].output_tokens, 3)
    assert.equal(h.devices.get(device), null)
    const next = await h.send(request(follow, stream))
    assert.equal(next.status, 400, next.text)
    assert.equal(JSON.parse(next.text).error.code, 'pro_session_quarantined')
    assert.equal(h.logs.at(-1).attempt_count, 0)
    assert.equal(h.captured.length, 1)
    assert.equal(h.receipts.length, 1)
    assert.equal(h.devices.get(device), null)
    const clean = await h.send(request([{ role: 'user', content: 'Different ordinary task.' }], stream, 'clean'))
    assert.equal(clean.status, 200, clean.text)
    assert.equal(h.captured.length, 2)
  })
}

function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('a stop reason carried only by the kernel trailer is recorded before the client sees its terminal', async (t) => {
  const h = await fixture(t, { trailerOnly: true, afterRefusal: () => new Promise((r) => setTimeout(r, 80)) })
  const response = await h.fetchStream(request(original, true))
  let output = ''
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    output += decoder.decode(chunk)
    if (output.includes('"type":"message_stop"')) {
      assert.ok(h.db.prepare('SELECT COUNT(*) n FROM pro_session_quarantines').get().n)
    }
  }
  assert.match(output, /"type":"message_stop"/)
  assert.equal(h.receipts.length, 1)
  assert.equal(h.receipts[0].output_tokens, 3)
})

test('disabled quarantine preserves legacy terminal delivery without waiting for trailers', async (t) => {
  const release = deferred()
  const h = await fixture(t, { enabled: false, trailerOnly: true, afterRefusal: () => release.promise })
  const response = await h.fetchStream(request(original, true))
  const reader = response.body.getReader()
  const firstTerminal = (async () => {
    let text = ''
    while (!text.includes('"type":"message_stop"')) {
      const part = await reader.read()
      if (part.done) return false
      text += new TextDecoder().decode(part.value)
    }
    return true
  })()
  let timeout
  try {
    const delayed = new Promise((r) => {
      timeout = setTimeout(() => r(false), 500)
    })
    assert.equal(await Promise.race([firstTerminal, delayed]), true)
  } finally {
    clearTimeout(timeout)
    release.resolve()
    await firstTerminal
    while (!(await reader.read()).done) {}
  }
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM pro_session_quarantines').get().n, 0)
})

test('a Continue already waiting for a slot sees the refusal before the first SSE finishes', async (t) => {
  const before = deferred(),
    after = deferred(),
    selected = deferred(),
    drain = deferred()
  const h = await fixture(t, {
    beforeRefusal: () => before.promise,
    afterRefusal: () => after.promise,
    beforeSelect: (n) => {
      if (n === 2) {
        selected.resolve()
        return drain.promise
      }
    },
  })
  try {
    const response = await h.fetchStream(request(original, true))
    const reader = response.body.getReader()
    const queued = h.send(request(follow, false))
    await selected.promise
    before.resolve()
    let seen = ''
    while (!seen.includes('"stop_reason":"refusal"')) {
      const part = await reader.read()
      assert.equal(part.done, false)
      seen += new TextDecoder().decode(part.value)
    }
    drain.resolve()
    const blocked = await queued
    assert.equal(blocked.status, 400, blocked.text)
    assert.equal(JSON.parse(blocked.text).error.code, 'pro_session_quarantined')
    assert.equal(h.captured.length, 1)
    after.resolve()
    while (!(await reader.read()).done) {}
    assert.equal(h.receipts.length, 1)
  } finally {
    before.resolve()
    after.resolve()
    drain.resolve()
  }
})

for (const [tier, enabled] of [
  ['pro', false],
  ['max', false],
]) {
  test(`legacy device refusal policy is preserved for tier=${tier}, enabled=${enabled}`, async (t) => {
    const h = await fixture(t, { tier, enabled })
    const first = await h.send(request(original, false))
    assert.equal(first.status, 200, first.text)
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM pro_session_quarantines').get().n, 0)
    assert.ok(h.devices.get(device))
    const next = await h.send(request(follow, false))
    assert.equal(JSON.parse(next.text).error.code, 'refusal_guard')
    assert.equal(h.captured.length, 1)
  })
}

test('an unreadable guard stops subscription dispatch before the kernel or metering', async (t) => {
  const h = await fixture(t, {
    makeQuarantineRepo: () => ({
      has() {
        throw new Error('fixture storage fault')
      },
    }),
  })
  const result = await h.send(request(original, false))
  assert.equal(result.status, 503, result.text)
  assert.equal(JSON.parse(result.text).error.code, 'pro_session_guard_unavailable')
  assert.equal(h.captured.length, 0)
  assert.equal(h.receipts.length, 0)
})

test('SQLite write loss retains real refusal usage and the fallback blocks the next paid request', async (t) => {
  const h = await fixture(t, {
    makeQuarantineRepo: (db) => {
      const repo = new ProSessionQuarantineRepo(db)
      repo.insert = {
        run() {
          throw new Error('fixture storage fault')
        },
      }
      return repo
    },
  })
  const first = await h.send(request(original, true))
  assert.equal(first.status, 200)
  assert.match(first.text, /"stop_reason":"refusal"/)
  assert.equal(h.receipts.length, 1)
  assert.equal(h.receipts[0].output_tokens, 3)
  const next = await h.send(request(follow, false))
  assert.ok(['pro_session_quarantined', 'pro_session_guard_unavailable'].includes(JSON.parse(next.text).error.code))
  assert.equal(h.captured.length, 1)
  assert.equal(h.receipts.length, 1)
})

for (const [tier, category] of [
  ['pro', 'oauth'],
  ['pro', 'api'],
  ['max', 'oauth'],
  ['max', 'api'],
]) {
  test(`count_tokens on actual ${tier} cannot dispatch an isolated context for key category=${category}`, async (t) => {
    const h = await fixture(t, { tier })
    await h.send(request(original, false))
    let countCalls = 0
    const result = await handleUserCountTokens(
      { apiKeyKind: 'managed', apiKeyRecord: { id: 'test-exclusive-key', group_type: 'all', category }, headers: {} },
      {},
      {
        requireAuth: () => true,
        cfg: { limits: { max_body_bytes: 8192 } },
        readBody: async () => request(follow, false),
        json: (_res, status, body) => ({ status, body }),
        proSessionQuarantineRepo: new ProSessionQuarantineRepo(h.db),
        refusalDevices: h.devices,
        settings: { get: (k, fallback) => h.options.get(k) ?? fallback },
        poolScheduler: {
          peekAccount: async () => ({
            ok: true,
            vm: { id: 'fixture', claude: { mode: 'setup-token', account_tier: tier } },
          }),
        },
        countTokensViaWorker: async () => {
          countCalls++
          return { ok: true, body: { input_tokens: 2 } }
        },
      },
    )
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'pro_session_quarantined')
    assert.equal(countCalls, 0)
    assert.equal(h.devices.get(device), null)
  })
}

test('an official Pro refusal cannot blacklist matching user text from another authenticated client', async (t) => {
  const h = await fixture(t)
  h.options.set('refusal_similarity_enabled', true)
  const messages = (context) => [
    { role: 'user', content: 'Review my project.' },
    { role: 'assistant', content: context },
    { role: 'user', content: 'Continue' },
  ]
  const first = request(messages('One unrelated history.'), true)
  const independent = request(messages('Another independent history.'), false, 'independent-session')
  assert.equal(refusalFingerprint(first), refusalFingerprint(independent))
  assert.equal((await h.send(first)).status, 200)
  const other = await h.send(independent, 'second')
  assert.equal(other.status, 200, other.text)
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM refusal_guards').get().n, 0)
  assert.equal(h.devices.get(device), null)
  assert.equal(h.receipts.length, 2)
})

test('a mixed pool resolves the actual slot before a pre-existing legacy exact match can block a device', async (t) => {
  const apiSlot = { id: 'api-fixture', claude: { mode: 'apikey', account_tier: 'max' } }
  let selected = false
  const h = await fixture(t, {
    otherVms: [apiSlot],
    selectVm: (vm, n) => (n >= 3 ? apiSlot : vm),
    beforeSelect: (n) => {
      selected = n > 1
    },
  })
  const fingerprints = new Set()
  const getGuard = h.guards.get.bind(h.guards)
  h.guards.get = (fingerprint) => {
    fingerprints.add(fingerprint)
    return getGuard(fingerprint)
  }
  const first = await h.send(request(original, false))
  assert.equal(first.status, 200)
  assert.ok(fingerprints.size)
  for (const fingerprint of fingerprints) h.guards.remember({ fingerprint })
  const get = h.devices.get.bind(h.devices)
  const lookupPhases = []
  h.devices.get = (id) => {
    lookupPhases.push(selected)
    return get(id)
  }
  const pro = await h.send(request(original, false))
  assert.equal(JSON.parse(pro.text).error.code, 'pro_session_quarantined')
  assert.ok(lookupPhases.every(Boolean))
  assert.equal(h.devices.get(device), null)
  const legacy = await h.send(request(original, false))
  assert.equal(legacy.status, 200)
  for (const fingerprint of fingerprints) h.guards.remember({ fingerprint })
  const blockedApi = await h.send(request(original, false))
  assert.equal(JSON.parse(blockedApi.text).error.code, 'refusal_guard')
  assert.ok(h.devices.get(device))
  assert.equal(h.captured.length, 2)
})

test('subscription protection excludes native relay API credentials, Codex and unknown tiers', () => {
  for (const vm of [
    { claude: { mode: 'apikey', account_tier: 'max' } },
    { claude: { mode: 'console', account_tier: 'pro' } },
    { platform: 'openai', claude: { mode: 'oauth', account_tier: 'max' } },
    { claude: { mode: 'oauth', account_tier: 'enterprise' } },
    null,
  ])
    assert.equal(isClaudeSubscriptionSlot(vm), false)
})

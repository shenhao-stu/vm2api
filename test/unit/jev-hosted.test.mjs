import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import {
  applyJevPatch,
  classifyJev,
  parsePolicyDecision,
  publicJevKeys,
} from '../../src/lib/protocol/jev-intercept.mjs'
import { runProtocolIntercept } from '../../src/lib/protocol/intercept-gate.mjs'
import { parseJevKeyInput } from '../../src/lib/protocol/jev-key-input.mjs'

const safe = () =>
  new Response(JSON.stringify({ answers: { usage_policy: { noul: 0.9 }, nsfw: { noul: 0.9 }, abuse: { noul: 0.9 } } }))
const config = (id, extra = {}) => ({
  enabled: true,
  base_url: `https://${id}.example`,
  api_keys: [`synthetic-${id}`],
  dedup_sec: 0,
  fail_open: false,
  ...extra,
})

test('an APIKEY export imports all 50 keys and reports duplicates and invalid line numbers without secret text', () => {
  const text = Array.from(
    { length: 50 },
    (_, i) => `APIKEY:synthetic-export-${i} 临时邮箱:synthetic-${i}@example.invalid`,
  ).join('\r\n')
  const parsed = parseJevKeyInput(`\ufeff${text}\nAPIKEY:synthetic-export-0\nAPIKEY:\nBearer secret-value`)
  assert.equal(parsed.keys.length, 50)
  assert.ok(parsed.keys.every((key) => !key.includes('@') && !key.includes('临时邮箱')))
  assert.equal(parsed.total, 53)
  assert.deepEqual(parsed.duplicates, [51])
  assert.deepEqual(
    parsed.errors.map((row) => row.line),
    [52, 53],
  )
  assert.equal(JSON.stringify(parsed.errors).includes('secret-value'), false)
  assert.equal(parseJevKeyInput(Array.from({ length: 1000 }, (_, i) => `key-${i}`)).tooMany, true)
  assert.equal(
    parseJevKeyInput('https://local.example/v1 synthetic-key').keys[0],
    'https://local.example/v1 synthetic-key',
  )
})

test('key patch rejects corruption atomically and canonicalizes APIKEY exports', () => {
  const settings = {
    value: { api_keys: ['old-key'] },
    get() {
      return this.value
    },
    set(_key, value) {
      this.value = value
    },
  }
  for (const keys of [
    ['same', 'APIKEY:same'],
    ['x'.repeat(501)],
    ['Bearer invalid'],
    ['APIKEY:'],
    ['APIKEY:one unexpected-note'],
    ['APIKEY:one 临时邮箱:not-an-email'],
  ]) {
    assert.equal(applyJevPatch(settings, { api_keys: keys }).ok, false)
    assert.deepEqual(settings.value.api_keys, ['old-key'])
  }
  assert.equal(
    applyJevPatch(settings, { api_keys: ['APIKEY:one 临时邮箱:one@example.invalid', 'APIKEY:two'] }).ok,
    true,
  )
  assert.deepEqual(settings.value.api_keys, ['one', 'two'])
})

test('export email metadata never enters the provider Authorization header', async () => {
  const cfg = config('export-header', { api_keys: ['APIKEY:synthetic-token 临时邮箱:synthetic@example.invalid'] })
  const headers = []
  await classifyJev('synthetic input', cfg, async (_url, init) => {
    headers.push(init.headers.authorization)
    return safe()
  })
  assert.deepEqual(headers, ['Bearer synthetic-token'])
})

test('a malformed model verdict obeys fail closed without banning the device', async () => {
  const banned = []
  const verdict = await runProtocolIntercept({
    inbound: { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'Explain a sorting algorithm.' }] },
    jev: config('invalid-response', { hard_regex_enabled: false }),
    fetchImpl: async () => new Response(JSON.stringify({ answers: {} })),
    devices: { block: (row) => banned.push(row), get: () => null },
    headers: { 'x-kin-device-id': 'invalid-verdict-device' },
  })
  assert.equal(verdict.action, 'block')
  assert.equal(verdict.reason, 'jev:unavailable')
  assert.deepEqual(banned, [])
  const opened = await classifyJev(
    'invalid fail open',
    config('invalid-open', { fail_open: true }),
    async () => new Response('{}'),
  )
  assert.equal(opened.action, 'pass')
  assert.equal(opened.reason, 'unavailable')
})

test('null, boolean, empty and out-of-range model scores cannot become an unsafe verdict', () => {
  for (const noul of [null, false, '', -1, 2]) {
    assert.equal(parsePolicyDecision({ answers: { nsfw: { noul } } }), null)
  }
})

test('429 respects Retry-After and restores the key automatically', async () => {
  const cfg = config('cooldown-key')
  let calls = 0
  await classifyJev(
    'limited',
    cfg,
    async () => {
      calls++
      return new Response('{}', { status: 429, headers: { 'retry-after': '120' } })
    },
    10_000,
  )
  assert.equal(publicJevKeys(cfg, 10_000)[0].retired, false)
  assert.equal(publicJevKeys(cfg, 10_000)[0].cooldown_until, 130_000)
  const waiting = await classifyJev(
    'still limited',
    cfg,
    async () => {
      calls++
      return safe()
    },
    129_999,
  )
  assert.equal(waiting.reason, 'unavailable')
  assert.equal(calls, 1)
  const recovered = await classifyJev(
    'recovered',
    cfg,
    async () => {
      calls++
      return safe()
    },
    130_001,
  )
  assert.equal(recovered.reason, 'safe')
  assert.equal(calls, 2)
})

test('one host overload never consumes or retires all 50 keys and recovers after backoff', async () => {
  const cfg = config('cooldown-host', { api_keys: Array.from({ length: 50 }, (_, i) => `synthetic-host-${i}`) })
  let calls = 0
  const down = await classifyJev(
    'overloaded',
    cfg,
    async () => {
      calls++
      return new Response('{}', { status: 529 })
    },
    100_000,
  )
  assert.equal(down.reason, 'unavailable')
  assert.equal(calls, 1)
  assert.ok(publicJevKeys(cfg, 100_000).every((key) => !key.retired && key.cooldown_until > 100_000))
  await classifyJev(
    'during backoff',
    cfg,
    async () => {
      calls++
      return safe()
    },
    100_001,
  )
  assert.equal(calls, 1)
  const recovered = await classifyJev(
    'host recovered',
    cfg,
    async () => {
      calls++
      return safe()
    },
    200_000,
  )
  assert.equal(recovered.reason, 'safe')
  assert.equal(calls, 2)
})

test('cooldown supports Retry-After dates, has a finite ceiling, and survives configuration saves', async () => {
  const now = Date.UTC(2026, 10, 4)
  for (const [id, retry, expected] of [
    ['date', new Date(now + 300_000).toUTCString(), 300_000],
    ['bound', '999999999999', 86400_000],
  ]) {
    const cfg = config(`cooldown-${id}`)
    await classifyJev(id, cfg, async () => new Response('{}', { status: 429, headers: { 'retry-after': retry } }), now)
    const settings = { get: () => cfg, set() {} }
    assert.equal(applyJevPatch(settings, { api_keys: cfg.api_keys }).ok, true)
    assert.equal(publicJevKeys(cfg, now)[0].cooldown_until, now + expected)
  }
})

test('repeated overload backs off and another host remains available', async () => {
  const cfg = config('backoff-origin')
  await classifyJev('first', cfg, async () => new Response('{}', { status: 529 }), 500_000)
  await classifyJev('second', cfg, async () => new Response('{}', { status: 529 }), 530_001)
  assert.equal(publicJevKeys(cfg, 530_001)[0].cooldown_until, 590_001)
  const calls = []
  const verdict = await classifyJev(
    'alternative',
    {
      ...cfg,
      api_keys: [...cfg.api_keys, 'https://alternative.example synthetic-alternative'],
    },
    async (url) => {
      calls.push(url)
      return safe()
    },
    530_002,
  )
  assert.equal(verdict.reason, 'safe')
  assert.deepEqual(calls, ['https://alternative.example/v1/systemone'])
})

test('Jev requires every requested question; a lone legacy safety answer cannot replace six questions', async () => {
  const questions = Array.from({ length: 6 }, (_, index) => ({
    id: `question_${index}`,
    instructions: 'Is this acceptable?',
    enabled: true,
  }))
  const cfg = config('complete-answers', { questions })
  for (const answers of [{ question_0: { noul: 0.9 } }, { safety: { noul: 0.9 } }]) {
    const result = await classifyJev('partial answers', cfg, async () => new Response(JSON.stringify({ answers })))
    assert.equal(result.action, 'block')
    assert.equal(result.reason, 'unavailable')
  }
  const complete = Object.fromEntries(questions.map(({ id }) => [id, { noul: 0.9 }]))
  assert.equal(
    (await classifyJev('all answered', cfg, async () => new Response(JSON.stringify({ answers: complete })))).reason,
    'safe',
  )
  const safetyOnly = config('legacy-safety', {
    questions: [{ id: 'safety', instructions: 'Custom safety question.', enabled: true }],
  })
  const legacy = () => new Response(JSON.stringify({ answers: { safety: { noul: 0.9 } } }))
  assert.equal((await classifyJev('one requested', safetyOnly, legacy)).reason, 'safe')
  assert.equal((await classifyJev('local compatibility', { ...cfg, provider: 'laya' }, legacy)).reason, 'safe')
})

test('one decision makes at most four attempts and the next request continues with other keys', async () => {
  const cfg = config('attempt-limit', { api_keys: Array.from({ length: 50 }, (_, i) => `synthetic-limited-${i}`) })
  const seen = []
  const limited = async (_url, init) => {
    seen.push(init.headers.authorization)
    return new Response('{}', { status: 429 })
  }
  const first = await classifyJev('first batch', cfg, limited)
  assert.equal(first.reason, 'unavailable')
  assert.equal(seen.length, 4)
  await classifyJev('next batch', cfg, limited)
  assert.equal(seen.length, 8)
  assert.equal(new Set(seen).size, 8)
})

test('real HTTP attempts share one total timeout instead of restarting it for each key', async (t) => {
  let calls = 0
  const server = http.createServer((_req, res) => {
    calls++
    setTimeout(() => {
      if (!res.destroyed) {
        res.writeHead(429)
        res.end('{}')
      }
    }, 130)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  const cfg = config('total-budget', {
    base_url: `http://127.0.0.1:${server.address().port}`,
    timeout_ms: 200,
    api_keys: ['budget-a', 'budget-b', 'budget-c'],
  })
  const started = performance.now()
  const result = await classifyJev('bounded request', cfg)
  const elapsed = performance.now() - started
  assert.equal(result.reason, 'unavailable')
  assert.equal(result.detail, '审核超时')
  assert.ok(calls <= 2)
  assert.ok(elapsed < 350, `elapsed ${elapsed} ms`)
})

test('client disconnect cancels the classifier and settles protocol listeners without fail-open dispatch', async (t) => {
  const req = Object.assign(new EventEmitter(), { headers: {} })
  const res = new EventEmitter()
  let entered
  const requested = new Promise((resolve) => {
    entered = resolve
  })
  let aborted = false
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    entered()
    return new Promise((_resolve, reject) =>
      init.signal.addEventListener(
        'abort',
        () => {
          aborted = true
          reject(init.signal.reason)
        },
        { once: true },
      ),
    )
  })
  const cfg = config('cancelled', { fail_open: true, hard_regex_enabled: false })
  const handler = createHandleProtocol({
    cfg: { distill: { enabled: false }, paths: { data: '/tmp/jev-synthetic-cancel' } },
    stats: { errors: 0 },
    json() {},
    settings: { get: (key, fallback) => (key === 'jev_intercept' ? cfg : fallback) },
  })
  const result = handler.applyProtocolIntercept({
    req,
    res,
    inbound: { messages: [{ role: 'user', content: 'Explain sorting.' }] },
    fp: {},
    logBag: {},
    requestId: 'synthetic-cancel',
  })
  await requested
  res.emit('close')
  assert.equal(await result, true)
  assert.equal(aborted, true)
  assert.equal(req.listenerCount('aborted'), 0)
  assert.equal(res.listenerCount('close'), 0)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_QUALITY_PROBE_CONFIG,
  evaluateQualityProbeResult,
  normalizeQualityProbeConfig,
  QualityProbeConfigError,
} from '../../src/lib/admin/quality-probe-policy.mjs'

const CONFIG_ERROR = {
  name: 'QualityProbeConfigError',
  code: 'invalid_quality_probe_config',
  status: 400,
}

function rejects(mutate) {
  const input = typeof mutate === 'function' ? mutate({ ...DEFAULT_QUALITY_PROBE_CONFIG }) : mutate
  assert.throws(() => normalizeQualityProbeConfig(input), CONFIG_ERROR)
}

function completes(text, extra = {}) {
  return { ok: true, status: 200, text, stop_reason: 'completed', ...extra }
}

test('default config matches the quality probe spec', () => {
  assert.deepEqual(
    { ...DEFAULT_QUALITY_PROBE_CONFIG },
    {
      enabled: false,
      interval_minutes: 15,
      model: 'gpt-6.1-sol',
      failure_threshold: 2,
      concurrency: 1,
      expected_answer: '21',
      prompt: DEFAULT_QUALITY_PROBE_CONFIG.prompt,
    },
  )
  assert.equal(Object.isFrozen(DEFAULT_QUALITY_PROBE_CONFIG), true)
  const { prompt } = DEFAULT_QUALITY_PROBE_CONFIG
  assert.equal(typeof prompt, 'string')
  assert.match(prompt, /圆形/)
  assert.match(prompt, /五角星形/)
  assert.match(prompt, /苹果味7/)
  assert.match(prompt, /桃子味6/)
  assert.match(prompt, /西瓜味4/)
  assert.match(prompt, /只输出最少数量的整数，不要解释。/)
  assert.equal(prompt.includes('21'), false)
  assert.equal(prompt.trim(), prompt)
  assert.ok(prompt.length <= 16_000)
})

test('normalize merges defaults, trims text and ignores unknown keys', () => {
  assert.deepEqual(normalizeQualityProbeConfig({}), { ...DEFAULT_QUALITY_PROBE_CONFIG })
  assert.deepEqual(normalizeQualityProbeConfig(), { ...DEFAULT_QUALITY_PROBE_CONFIG })
  assert.deepEqual(normalizeQualityProbeConfig(undefined), { ...DEFAULT_QUALITY_PROBE_CONFIG })
  const out = normalizeQualityProbeConfig({
    enabled: false,
    interval_minutes: 60,
    model: '  gpt-6.1-sol-mini  ',
    failure_threshold: 5,
    concurrency: 7,
    expected_answer: '  21\n',
    prompt: '  count the candies  ',
    unrelated: 'ignored',
  })
  assert.deepEqual(out, {
    enabled: false,
    interval_minutes: 60,
    model: 'gpt-6.1-sol-mini',
    failure_threshold: 5,
    concurrency: 7,
    expected_answer: '21',
    prompt: 'count the candies',
  })
  assert.equal('unrelated' in out, false)
  const defaults = normalizeQualityProbeConfig({ enabled: true })
  assert.equal(defaults.interval_minutes, 15)
  assert.equal(defaults.model, 'gpt-6.1-sol')
  assert.equal(defaults.failure_threshold, 2)
  assert.equal(defaults.concurrency, 1)
  assert.equal(defaults.expected_answer, '21')
  assert.equal(defaults.prompt, DEFAULT_QUALITY_PROBE_CONFIG.prompt)
})

test('normalize rejects non-object payloads', () => {
  for (const value of [null, 'cfg', 42, true, [], ['enabled']]) {
    assert.throws(() => normalizeQualityProbeConfig(value), CONFIG_ERROR)
  }
  assert.throws(() => normalizeQualityProbeConfig(null), QualityProbeConfigError)
})

test('normalize enforces field types without coercion', () => {
  rejects((cfg) => ({ ...cfg, enabled: 'true' }))
  rejects((cfg) => ({ ...cfg, enabled: 1 }))
  rejects((cfg) => ({ ...cfg, enabled: null }))

  rejects((cfg) => ({ ...cfg, interval_minutes: '15' }))
  rejects((cfg) => ({ ...cfg, interval_minutes: 15.5 }))
  rejects((cfg) => ({ ...cfg, interval_minutes: 0 }))
  rejects((cfg) => ({ ...cfg, interval_minutes: 1_441 }))
  rejects((cfg) => ({ ...cfg, interval_minutes: Number.NaN }))
  rejects((cfg) => ({ ...cfg, interval_minutes: null }))

  rejects((cfg) => ({ ...cfg, failure_threshold: '2' }))
  rejects((cfg) => ({ ...cfg, failure_threshold: 2.5 }))
  rejects((cfg) => ({ ...cfg, failure_threshold: 0 }))
  rejects((cfg) => ({ ...cfg, failure_threshold: 101 }))
  rejects((cfg) => ({ ...cfg, failure_threshold: true }))

  for (const concurrency of ['10', 1.5, 0, 101, null, true, NaN, Infinity]) {
    rejects((cfg) => ({ ...cfg, concurrency }))
  }
  assert.equal(normalizeQualityProbeConfig({ concurrency: 1 }).concurrency, 1)
  assert.equal(normalizeQualityProbeConfig({ concurrency: 100 }).concurrency, 100)

  rejects((cfg) => ({ ...cfg, model: '' }))
  rejects((cfg) => ({ ...cfg, model: '   ' }))
  rejects((cfg) => ({ ...cfg, model: 'm'.repeat(201) }))
  rejects((cfg) => ({ ...cfg, model: 61 }))
  rejects((cfg) => ({ ...cfg, model: null }))

  rejects((cfg) => ({ ...cfg, prompt: '' }))
  rejects((cfg) => ({ ...cfg, prompt: ' \n\t ' }))
  rejects((cfg) => ({ ...cfg, prompt: 'p'.repeat(16_001) }))
  rejects((cfg) => ({ ...cfg, prompt: ['p'] }))

  rejects((cfg) => ({ ...cfg, expected_answer: '' }))
  rejects((cfg) => ({ ...cfg, expected_answer: '   ' }))
  rejects((cfg) => ({ ...cfg, expected_answer: 'a'.repeat(513) }))
  rejects((cfg) => ({ ...cfg, expected_answer: 21 }))
  rejects((cfg) => ({ ...cfg, expected_answer: null }))
})

test('normalize accepts the inclusive bounds', () => {
  const low = normalizeQualityProbeConfig({
    interval_minutes: 1,
    failure_threshold: 1,
    model: 'gpt-m',
    expected_answer: '1',
    prompt: 'p',
  })
  assert.equal(low.interval_minutes, 1)
  assert.equal(low.failure_threshold, 1)

  const high = normalizeQualityProbeConfig({
    interval_minutes: 1_440,
    failure_threshold: 100,
    model: 'gpt-' + 'm'.repeat(196),
    expected_answer: 'a'.repeat(512),
    prompt: 'p'.repeat(16_000),
  })
  assert.equal(high.interval_minutes, 1_440)
  assert.equal(high.failure_threshold, 100)
  assert.equal(high.model.length, 200)
  assert.equal(high.expected_answer.length, 512)
  assert.equal(high.prompt.length, 16_000)
})

test('evaluate marks the expected integer answer as correct', () => {
  assert.deepEqual(evaluateQualityProbeResult(completes('21'), '21'), {
    result: 'correct',
    answer: '21',
    error: null,
  })
  assert.deepEqual(evaluateQualityProbeResult(completes(' 21\n'), '21'), {
    result: 'correct',
    answer: '21',
    error: null,
  })
  assert.deepEqual(evaluateQualityProbeResult(completes('0021'), ' 21 '), {
    result: 'correct',
    answer: '0021',
    error: null,
  })
  assert.equal(evaluateQualityProbeResult(completes('+21'), '21').result, 'invalid')
})

test('evaluate marks other integers as wrong with a fixed message', () => {
  const wrong121 = evaluateQualityProbeResult(completes('121'), '21')
  const wrong29 = evaluateQualityProbeResult(completes('29'), '21')
  const wrongNeg = evaluateQualityProbeResult(completes('-21'), '21')
  for (const res of [wrong121, wrong29, wrongNeg]) {
    assert.equal(res.result, 'wrong')
    assert.equal(typeof res.error, 'string')
    assert.ok(res.error.length > 0)
  }
  assert.equal(wrong121.answer, '121')
  assert.equal(wrong29.answer, '29')
  assert.equal(wrong121.error, wrong29.error)
  assert.equal(wrong121.error, wrongNeg.error)
})

test('evaluate refuses to guess at non-integer answers', () => {
  const cases = [
    '21.5',
    '21 or 29',
    'answer21',
    '答案是 21',
    '```\n21\n```',
    '21\n\nBecause the worst case needs 21 candies.',
    '21,',
    'twenty one',
  ]
  for (const text of cases) {
    const res = evaluateQualityProbeResult(completes(text), '21')
    assert.equal(res.result, 'invalid', `expected invalid for ${JSON.stringify(text)}`)
    assert.equal(res.error, 'quality probe answer is not a bare integer')
    assert.equal(typeof res.answer, 'string')
  }
})

test('evaluate reports transport failures as errors without leaking upstream text', () => {
  const timeout = evaluateQualityProbeResult(
    { ok: false, status: 504, text: 'upstream boom ECONNRESET', stop_reason: null },
    '21',
  )
  assert.deepEqual(timeout, {
    result: 'error',
    answer: null,
    error: 'quality probe request failed with HTTP 504',
  })
  assert.equal(timeout.error.includes('boom'), false)
  assert.equal(timeout.error.includes('ECONNRESET'), false)

  const limited = evaluateQualityProbeResult({ ok: false, status: 429, text: '' }, '21')
  assert.deepEqual(limited, {
    result: 'error',
    answer: null,
    error: 'quality probe request failed with HTTP 429',
  })

  const noStatus = evaluateQualityProbeResult({ ok: false }, '21')
  assert.equal(noStatus.result, 'error')
  assert.equal(noStatus.error, 'quality probe request failed with HTTP unknown')

  const stringStatus = evaluateQualityProbeResult(
    { ok: true, status: '200', text: '21', stop_reason: 'completed' },
    '21',
  )
  assert.equal(stringStatus.result, 'error')
  assert.equal(stringStatus.error, 'quality probe request failed with HTTP unknown')

  const non2xxOk = evaluateQualityProbeResult({ ok: true, status: 302, text: '21', stop_reason: 'completed' }, '21')
  assert.equal(non2xxOk.result, 'error')
  assert.match(non2xxOk.error, /HTTP 302/)

  assert.equal(evaluateQualityProbeResult(null, '21').result, 'error')
  assert.equal(evaluateQualityProbeResult('nope', '21').result, 'error')
})

test('evaluate treats unfinished, refused and empty runs as invalid', () => {
  const unfinished = evaluateQualityProbeResult(completes('21', { stop_reason: 'max_tokens' }), '21')
  assert.deepEqual(unfinished, {
    result: 'invalid',
    answer: null,
    error: 'quality probe did not finish with a completed answer',
  })
  assert.equal(evaluateQualityProbeResult(completes('21', { stop_reason: null }), '21').result, 'invalid')
  assert.equal(evaluateQualityProbeResult(completes('21', { stop_reason: 'refusal' }), '21').result, 'invalid')

  const empty = evaluateQualityProbeResult(completes(''), '21')
  assert.deepEqual(empty, {
    result: 'invalid',
    answer: null,
    error: 'quality probe returned an empty answer',
  })
  assert.equal(evaluateQualityProbeResult(completes('   \n\t '), '21').result, 'invalid')
  assert.equal(evaluateQualityProbeResult(completes(undefined), '21').result, 'invalid')
  assert.equal(evaluateQualityProbeResult(completes(null), '21').result, 'invalid')
})

test('evaluate compares non-integer expectations as exact whole text', () => {
  assert.deepEqual(evaluateQualityProbeResult(completes('paris'), 'paris'), {
    result: 'correct',
    answer: 'paris',
    error: null,
  })
  assert.equal(evaluateQualityProbeResult(completes('  paris \n'), 'paris').result, 'correct')
  assert.equal(evaluateQualityProbeResult(completes('Paris'), 'paris').result, 'wrong')
  assert.equal(evaluateQualityProbeResult(completes('the answer is paris'), 'paris').result, 'wrong')
  assert.equal(evaluateQualityProbeResult(completes('paris!'), 'paris').result, 'wrong')
  assert.equal(evaluateQualityProbeResult(completes('paris'), '  paris  ').result, 'correct')
  assert.equal(evaluateQualityProbeResult(completes('苹果味7'), '苹果味7').result, 'correct')
})

test('evaluate bounds the returned answer and rejects unusable expectations', () => {
  const long = evaluateQualityProbeResult(completes('a'.repeat(5_000)), 'paris')
  assert.equal(long.answer.length, 4_000)
  assert.equal(long.result, 'invalid')
  assert.equal(evaluateQualityProbeResult(completes(`${'0'.repeat(3998)}21garbage`), '21').result, 'invalid')
  assert.equal(evaluateQualityProbeResult(completes('21', { text_truncated: true }), '21').result, 'invalid')

  for (const expected of [undefined, null, '', '   ', 21, ['21'], 'a'.repeat(513)]) {
    const res = evaluateQualityProbeResult(completes('21'), expected)
    assert.equal(res.result, 'invalid')
    assert.equal(res.answer, null)
    assert.equal(typeof res.error, 'string')
  }
})

test('defaults generate no background traffic and refuse Claude/Fable probe models', () => {
  assert.equal(normalizeQualityProbeConfig().enabled, false)
  assert.equal(normalizeQualityProbeConfig().concurrency, 1)
  for (const model of ['claude-sonnet', 'claude-fable', 'gpt-fable']) rejects({ model })
})

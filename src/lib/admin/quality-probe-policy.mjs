const MAX_MODEL_LENGTH = 200
const MAX_PROMPT_LENGTH = 16_000
const MAX_EXPECTED_ANSWER_LENGTH = 512
const MAX_ANSWER_LENGTH = 4_000
const MIN_INTERVAL_MINUTES = 1
const MAX_INTERVAL_MINUTES = 1_440
const MIN_FAILURE_THRESHOLD = 1
const MAX_FAILURE_THRESHOLD = 100
const MIN_CONCURRENCY = 1
const MAX_CONCURRENCY = 100
const INTEGER_ANSWER = /^-?\d+$/

const DEFAULT_PROMPT =
  '在一个黑色的袋子里放有三种口味的糖果，每种糖果有圆形和五角星形两种形状。允许凭手感选择要摸出的形状，但摸出前不能辨别口味。数量如下：圆形：苹果味7、桃子味9、西瓜味8；五角星形：苹果味7、桃子味6、西瓜味4。参赛者在活动前决定摸出的糖果数目，可以分别规定两种形状摸出的数量。最少取出多少颗，才能保证同时拥有圆形苹果味与五角星桃子味，或圆形桃子味与五角星苹果味的一组糖果？只输出最少数量的整数，不要解释。'

export const DEFAULT_QUALITY_PROBE_CONFIG = Object.freeze({
  enabled: false,
  interval_minutes: 15,
  model: 'gpt-6.1-sol',
  failure_threshold: 2,
  expected_answer: '21',
  prompt: DEFAULT_PROMPT,
  // Distinct accounts measured at the same time; a finished account is replaced at once.
  concurrency: 1,
})

export class QualityProbeConfigError extends Error {
  constructor(message, code = 'invalid_quality_probe_config', status = 400) {
    super(message)
    this.name = 'QualityProbeConfigError'
    this.code = code
    this.status = status
  }
}

function fail(message) {
  throw new QualityProbeConfigError(message)
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') fail(`${field} must be a boolean`)
  return value
}

function requireInteger(value, field, min, max) {
  const valid = typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
  if (!valid) fail(`${field} must be an integer between ${min} and ${max}`)
  return value
}

function requireText(value, field, max) {
  if (typeof value !== 'string') fail(`${field} must be a non-empty string`)
  const text = value.trim()
  if (!text) fail(`${field} must be a non-empty string`)
  if (text.length > max) fail(`${field} must be at most ${max} characters`)
  return text
}

/**
 * Merge a partial quality probe config onto the defaults and validate it.
 * Rejects wrong types instead of coercing them.
 */
export function normalizeQualityProbeConfig(input) {
  const source = input === undefined ? {} : input
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    fail('quality probe config must be an object')
  }
  const pick = (key) => (source[key] === undefined ? DEFAULT_QUALITY_PROBE_CONFIG[key] : source[key])
  const model = requireText(pick('model'), 'model', MAX_MODEL_LENGTH)
  if (!/^(gpt-|codex(?:-|$))/i.test(model) || /fable/i.test(model)) fail('model must be a GPT/Codex model')
  return {
    enabled: requireBoolean(pick('enabled'), 'enabled'),
    interval_minutes: requireInteger(
      pick('interval_minutes'),
      'interval_minutes',
      MIN_INTERVAL_MINUTES,
      MAX_INTERVAL_MINUTES,
    ),
    model,
    failure_threshold: requireInteger(
      pick('failure_threshold'),
      'failure_threshold',
      MIN_FAILURE_THRESHOLD,
      MAX_FAILURE_THRESHOLD,
    ),
    expected_answer: requireText(pick('expected_answer'), 'expected_answer', MAX_EXPECTED_ANSWER_LENGTH),
    prompt: requireText(pick('prompt'), 'prompt', MAX_PROMPT_LENGTH),
    concurrency: requireInteger(pick('concurrency'), 'concurrency', MIN_CONCURRENCY, MAX_CONCURRENCY),
  }
}

function outcome(result, answer, error) {
  return { result, answer, error }
}

function failedRequest(status) {
  return outcome(
    'error',
    null,
    `quality probe request failed with HTTP ${Number.isInteger(status) && status > 0 ? status : 'unknown'}`,
  )
}

/**
 * Judge a finished quality probe run against the expected answer.
 * Pure: no IO, and no upstream error text leaks into the returned message.
 */
export function evaluateQualityProbeResult(result, expectedAnswer) {
  const expected = typeof expectedAnswer === 'string' ? expectedAnswer.trim() : ''
  if (!expected || expected.length > MAX_EXPECTED_ANSWER_LENGTH) {
    return outcome('invalid', null, 'quality probe expected answer is unusable')
  }
  const probe = result && typeof result === 'object' && !Array.isArray(result) ? result : {}
  const status = probe.status
  const httpOk = Number.isInteger(status) && status >= 200 && status <= 299
  if (probe.ok !== true || !httpOk) return failedRequest(status)
  if (probe.stop_reason !== 'completed') {
    return outcome('invalid', null, 'quality probe did not finish with a completed answer')
  }
  const text = typeof probe.text === 'string' ? probe.text : ''
  const answer = text.trim().slice(0, MAX_ANSWER_LENGTH)
  if (text.trim().length > MAX_ANSWER_LENGTH || probe.text_truncated) {
    return outcome('invalid', answer, 'quality probe answer was truncated')
  }
  if (!answer) return outcome('invalid', null, 'quality probe returned an empty answer')
  if (INTEGER_ANSWER.test(expected)) {
    if (!INTEGER_ANSWER.test(answer)) {
      return outcome('invalid', answer, 'quality probe answer is not a bare integer')
    }
    const same = BigInt(answer) === BigInt(expected)
    return same ? outcome('correct', answer, null) : outcome('wrong', answer, 'quality probe answer is incorrect')
  }
  if (answer === expected) return outcome('correct', answer, null)
  return outcome('wrong', answer, 'quality probe answer is incorrect')
}

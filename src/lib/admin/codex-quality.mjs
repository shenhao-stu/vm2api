import { createHash, randomUUID } from 'node:crypto'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { getVm, listVms, setCodexQualityPause } from '../vm/vm-registry.mjs'
import { readCodexAccounts, isCodexVm } from '../vm/codex-slot.mjs'
import { checkQualityExit, qualityExitBinding } from '../pool/codex-quality-exit.mjs'
import { eligibleQualitySlot, qualityOff } from '../pool/codex-quality-gate.mjs'

const MINUTE = 60_000
const DAY = 1440 * MINUTE
const SETTINGS = 'codex_quality_v1'
const MODEL = 'gpt-6.1-sol'
const QUESTION =
  '袋中糖果分圆形和星形。苹果、桃子、西瓜的圆形数量依次是7、9、8，星形数量依次是7、6、4。摸出前能选形状但不知道口味。事先选定两种形状各摸多少颗，最少总共摸多少颗，可保证有圆苹果与星桃子，或圆桃子与星苹果？只输出一个整数。'

// One completed, attributed response is one observation. Transient failures cannot vote.
export function judgeQuality(body, receipt, vmId) {
  if (
    receipt?.vm_id !== vmId ||
    receipt.model !== MODEL ||
    receipt.final_state !== 'verified' ||
    receipt.attempt_count !== 1 ||
    body?.status !== 'completed'
  )
    return 'unverified'
  if (receipt.model_mismatch || (receipt.upstream_model && receipt.upstream_model !== MODEL)) return 'model_mismatch'
  const answer = (Array.isArray(body.output) ? body.output : [])
    .filter((item) => item.type === 'message' && item.role === 'assistant')
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text)
    .join('')
    .trim()
  if (!/^-?\d{1,12}$/.test(answer)) return 'invalid'
  return Number(answer) === 21 ? 'correct' : 'wrong'
}

export function nextQualityState(state, result, paused, now) {
  const next = { ...state, last_at: now, result }
  if (paused) {
    if (result === 'correct' && state.first_pass && now >= state.first_pass + 10 * MINUTE)
      return { ...next, wrong: 0, first_pass: null, due: 0, action: 'recover' }
    if (result === 'correct') return { ...next, first_pass: now, due: now + 10 * MINUTE, action: null }
    return { ...next, first_pass: null, due: now + DAY, action: null }
  }
  const wrong = result === 'correct' ? 0 : (state.wrong || 0) + Number(result === 'wrong')
  const pause = result === 'wrong' && wrong >= 2
  return { ...next, wrong, first_pass: null, due: pause ? now + DAY : 0, action: pause ? 'pause' : null }
}

function identity(project, id) {
  const [a] = readCodexAccounts(project, id)
  if (!a) return null
  return createHash('sha256')
    .update(
      JSON.stringify([
        a.chatgpt_account_id || '',
        a.email || '',
        a.chatgpt_account_id || a.email ? '' : a.access_token,
      ]),
    )
    .digest('hex')
}

async function boundedJson(response) {
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 128 * 1024) throw new Error('quality_response_too_large')
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export function loopbackMeasurement({ project, port, apiKey, receipt }) {
  return async (vmId, requestId) => {
    const binding = qualityExitBinding(project, getVm(project, vmId))
    if (!(await checkQualityExit(binding))) return 'exit_unverified'
    const r = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
      headers: {
        authorization: 'Bearer ' + apiKey,
        'content-type': 'application/json',
        'x-kin-vm': vmId,
        'x-kin-quality-probe': '1',
        'x-request-id': requestId,
        'session-id': requestId,
      },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        store: false,
        max_output_tokens: 512,
        reasoning: { effort: 'medium' },
        input: [{ role: 'user', content: QUESTION }],
      }),
    })
    if (!r.ok) {
      await r.body?.cancel()
      return 'http_' + r.status
    }
    const body = await boundedJson(r)
    return judgeQuality(body, receipt(requestId), vmId)
  }
}

export class CodexQualityMonitor {
  constructor({ project, measure, quotaPolicy, settings = () => new SettingsRepo(), now = Date.now }) {
    Object.assign(this, { project, measure, quotaPolicy, settings, now })
    this.timer = null
    this.round = null
    this.stopped = false
    this.revision = 0
  }
  mode() {
    return this.settings().get(SETTINGS, 'manual')
  }
  configure(mode) {
    if (!['manual', 'hourly', 'daily'].includes(mode)) throw new Error('invalid_quality_mode')
    this.settings().set(SETTINGS, mode)
    this.revision++
    return this.snapshot()
  }
  state(id) {
    const account = identity(this.project, id)
    const state = this.settings().get(SETTINGS + ':' + id)
    if (!account || state?.account !== account) return { account, wrong: 0, first_pass: null, due: 0 }
    if (state.quality_paused && !qualityOff(getVm(this.project, id)))
      return { ...state, quality_paused: false, wrong: 0, first_pass: null, due: 0 }
    return state
  }
  save(id, state) {
    this.settings().set(SETTINGS + ':' + id, state)
  }
  snapshot() {
    return {
      mode: this.mode(),
      model: MODEL,
      running: !!this.round,
      items: listVms(this.project)
        .filter(isCodexVm)
        .map((vm) => {
          const { account, ...state } = this.state(vm.id)
          return { vm_id: vm.id, paused: qualityOff(getVm(this.project, vm.id)), ...state }
        }),
    }
  }
  start() {
    this.timer = setInterval(() => {
      this.run(false)?.catch(() => console.warn('[codex-quality] round failed'))
    }, MINUTE)
    this.timer.unref()
  }
  async stop() {
    this.stopped = true
    clearInterval(this.timer)
    await this.round
  }
  run(manual) {
    if (this.stopped || this.round || (!manual && this.mode() === 'manual')) return null
    const revision = this.revision
    this.round = this.runRound(manual, revision).finally(() => {
      this.round = null
    })
    return this.round
  }
  async runRound(manual, revision) {
    const interval = this.mode() === 'hourly' ? 60 * MINUTE : DAY
    for (const { id } of listVms(this.project).filter(isCodexVm)) {
      if (this.stopped || this.revision !== revision) break
      const vm = getVm(this.project, id)
      if (!vm) continue
      const state = this.state(vm.id)
      const now = this.now()
      const paused = qualityOff(vm)
      // A replacement account/old marker does not inherit prior measurement or a free retest.
      if (paused && !state.due) {
        this.save(vm.id, { ...state, due: now + DAY })
        continue
      }
      if (
        !state.account ||
        (paused && now < state.due) ||
        (!paused && this.mode() !== 'manual' && state.last_at && now < state.last_at + interval)
      )
        continue
      if (!eligibleQualitySlot(vm, this.project, MODEL, this.quotaPolicy(), now)) continue
      const requestId = 'codex-quality-' + randomUUID()
      // Consume before IO. A process death never retries an uncertain measurement on startup.
      this.save(vm.id, {
        ...state,
        next_normal: now + interval,
        due: paused ? now + DAY : 0,
        first_pass: null,
        last_at: now,
        result: 'pending',
        request_id: requestId,
      })
      let result
      try {
        result = await this.measure(vm.id, requestId)
      } catch {
        result = 'transport_error'
      }
      if (this.revision !== revision || this.stopped || identity(this.project, vm.id) !== state.account) continue
      const current = getVm(this.project, vm.id)
      if (qualityOff(current) !== paused) continue
      if (
        ['correct', 'wrong'].includes(result) &&
        !eligibleQualitySlot(current, this.project, MODEL, this.quotaPolicy(), this.now())
      )
        result = 'skipped'
      const next = nextQualityState(state, result, paused, this.now())
      if (next.action) setCodexQualityPause(this.project, vm.id, next.action === 'pause')
      const { action, ...saved } = next
      this.save(vm.id, {
        ...saved,
        quality_paused: qualityOff(getVm(this.project, vm.id)),
        request_id: requestId,
        next_normal: this.now() + interval,
      })
    }
  }
}

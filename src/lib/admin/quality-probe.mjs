import { setCodexScheduleOff as setScheduleOff } from '../vm/codex-schedule.mjs'
import path from 'node:path'
import { listVmRecordFiles } from '../vm/vm-file.mjs'
import { legacyQualityState } from './codex-quality.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { getVm, summarizeVm } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { readCodexAccounts, enrichCodexAccountIdentity } from '../vm/codex-slot.mjs'
import { orderCodexSessionSlots } from '../pool/codex-slot-pool.mjs'
import { openAIRuntimeSignals } from '../pool/openai-account-runtime.mjs'
import {
  DEFAULT_QUALITY_PROBE_CONFIG,
  normalizeQualityProbeConfig,
  evaluateQualityProbeResult,
} from './quality-probe-policy.mjs'

export const QUALITY_PROBE_KEY = 'quality_probe'
export const QUALITY_PROBE_PAUSE_REASON = 'quality_probe_failed'
/** A paused account is re-tested after this quiet period, and after every failed re-test. */
export const QUALITY_RECOVERY_RETRY_MS = 24 * 60 * 60_000
/** A correct recovery answer only counts once a second answer confirms it. */
export const QUALITY_RECOVERY_CONFIRM_MS = 10 * 60_000
/** Per-account journal bound. Entries are codes and timestamps only. */
const RECOVERY_HISTORY_LIMIT = 20

// Read slot records only. Summarizing the mixed fleet opens credentials and computes quota for unrelated requests.
function codexRecords(project) {
  return listVmRecordFiles(path.join(project, 'vms'))
    .map((name) => getVm(project, name.slice(0, -5)))
    .filter((vm) => vm && isCodexVm(vm))
}

const emptyResult = () => ({
  consecutive_wrong: 0,
  last_result: null,
  last_answer: null,
  last_error: null,
  last_test_at: null,
  safety_buffering: null,
  safety_buffering_enabled: null,
  safety_buffering_faster_model: null,
  upstream_model: null,
  signal_test_at: null,
  quality_pause_trigger: null,
  // Recovery bookkeeping for a quality pause; a null phase means "not recovering".
  recovery_phase: null,
  recovery_first_pass_at: null,
  recovery_next_at: null,
  recovery_history: [],
})

const iso = (ms) => new Date(ms).toISOString()
const parseMs = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null)
const safeReason = (value) => (typeof value === 'string' && value ? value.slice(0, 160) : null)

/** 调度关 carrying our own reason is the only pause this runner may lift. */
export function isQualityPause(vm) {
  return !!vm && vm.schedule_off === true && vm.schedule_disabled_reason === QUALITY_PROBE_PAUSE_REASON
}

function recoveryEntry(at, event, result, nextAt, reason) {
  return {
    at: iso(at),
    event,
    result: result || null,
    next_at: nextAt ? iso(nextAt) : null,
    reason: safeReason(reason),
  }
}

function pushHistory(state, entry) {
  const history = Array.isArray(state.recovery_history) ? state.recovery_history : []
  state.recovery_history = [...history, entry].slice(-RECOVERY_HISTORY_LIMIT)
  return state.recovery_history
}

/** Structured, credential-free journal line: codes and times only. */
function logRecovery(vmId, event, result, at, nextAt) {
  try {
    console.info(
      '[quality-probe-recovery]',
      JSON.stringify({ vm_id: vmId, event, result: result || null, at, next_at: nextAt || null }),
    )
  } catch {
    // A log line must never break a probe.
  }
}

/** One owner, one round at a time, up to `config.concurrency` distinct accounts in flight. */
export class QualityProbeRunner {
  constructor({
    projectRoot,
    runTest,
    settings = () => new SettingsRepo(),
    isOwner = () => true,
    getQuotaPolicy = () => ({}),
    guarded = false,
    now = Date.now,
  }) {
    this.guarded = guarded
    this.projectRoot = projectRoot
    this.runTest = runTest
    this.settings = settings
    this.isOwner = isOwner
    this.getQuotaPolicy = getQuotaPolicy
    this.now = now
    this.running = null
    this.timer = null
    this.started = false
    this.stopping = false
    this.revision = 0
    /** Recovery probes this process is running; their persisted stage must not be settled. */
    this.probing = new Set()
    /** What the armed timer will do; the timer callback re-reads it. */
    this.wake = null
    this.progress = {
      running: false,
      total: 0,
      completed: 0,
      current_vm_id: null,
      active_count: 0,
      active_vm_ids: [],
      started_at: null,
      finished_at: null,
      next_run_at: null,
    }
  }

  read({ recover = false } = {}) {
    const stored = this.settings().get(QUALITY_PROBE_KEY) ?? this.importPreviousSettings()
    const saved = stored && typeof stored === 'object' ? stored : {}
    let config = { ...DEFAULT_QUALITY_PROBE_CONFIG }
    try {
      config = normalizeQualityProbeConfig(saved.config)
    } catch {
      // Invalid persisted settings must never schedule paid traffic.
    }
    // Settings persisted before an option existed must run on today's default,
    // not on `undefined`.
    const merged = {
      ...saved,
      states: saved.states && typeof saved.states === 'object' ? saved.states : {},
      config,
    }
    // Legacy pauses (and a stage left behind by a crash) get a schedule once.
    if (recover && this.isOwner() && this.migrateRecovery(merged)) this.settings().set(QUALITY_PROBE_KEY, merged)
    return merged
  }

  importPreviousSettings() {
    if (!this.guarded || !this.isOwner()) return {}
    const store = this.settings()
    const mode = store.get('codex_quality_v1')
    if (!['manual', 'daily', 'hourly'].includes(mode)) return {}
    const interval = mode === 'daily' ? 1440 : 60
    const config = normalizeQualityProbeConfig({ enabled: mode !== 'manual', interval_minutes: interval })
    const states = {}
    let next = 0
    for (const vm of codexRecords(this.projectRoot)) {
      const prior = legacyQualityState(this.projectRoot, vm.id, store.get('codex_quality_v1:' + vm.id))
      if (!prior) continue
      states[vm.id] = { ...emptyResult(), ...prior, account_identity: accountIdentity(this.projectRoot, vm.id) }
      next = Math.max(next, Date.parse(prior.last_dispatched_at) + interval * 60000)
    }
    const migrated = { config, states, next_run_at: iso(next || this.now() + interval * 60000) }
    store.set(QUALITY_PROBE_KEY, migrated)
    return migrated
  }

  /**
   * Give every quality pause a recovery schedule. Runs on read/arm/snapshot/start,
   * writes only when something actually changed, and never touches the stage of a
   * recovery probe this process still has in flight.
   */
  migrateRecovery(saved) {
    const now = this.now()
    let changed = false
    const paused = new Set()
    for (const vm of codexRecords(this.projectRoot)) {
      if (!isQualityPause(vm)) continue
      paused.add(vm.id)
      if (this.probing.has(vm.id)) continue
      const identity = accountIdentity(this.projectRoot, vm.id)
      const known = saved.states[vm.id]?.account_identity === identity
      // Unknown evidence (no state, or another account) restarts the quiet period.
      const state = known ? saved.states[vm.id] : { ...emptyResult(), account_identity: identity }
      if (!known) changed = true
      if (this.settleStage(state, now)) {
        changed = true
        const entry = recoveryEntry(now, 'scheduled', null, state.recovery_next_at, null)
        pushHistory(state, entry)
        logRecovery(vm.id, entry.event, null, entry.at, entry.next_at)
      }
      saved.states[vm.id] = state
    }
    for (const [vmId, state] of Object.entries(saved.states)) {
      if (paused.has(vmId) || this.probing.has(vmId)) continue
      if (!state || typeof state !== 'object') continue
      if (!['cooldown', 'confirming', 'probing'].includes(state.recovery_phase)) continue
      // The pause is gone (operator / auth), so the recovery schedule is moot.
      state.recovery_phase = null
      state.recovery_first_pass_at = null
      state.recovery_next_at = null
      changed = true
    }
    return changed
  }

  /** Put one paused account on a recovery stage, keeping an already scheduled deadline. */
  settleStage(state, now) {
    const firstPass = parseMs(state.recovery_first_pass_at)
    const nextAt = parseMs(state.recovery_next_at)
    const lastTest = parseMs(state.last_test_at)
    const deadline = lastTest == null ? now + QUALITY_RECOVERY_RETRY_MS : lastTest + QUALITY_RECOVERY_RETRY_MS
    if (state.recovery_phase === 'probing') {
      // A recorded dispatch can already have been charged. An interrupted
      // recovery takes another quiet period, never an immediate confirmation.
      if (state.pending_request_id) {
        state.pending_request_id = null
        this.armCooldown(state, Math.max(parseMs(state.last_dispatched_at) || 0, now))
        return true
      }
      if (firstPass != null) {
        state.recovery_phase = 'confirming'
        state.recovery_next_at = iso(nextAt ?? firstPass + QUALITY_RECOVERY_CONFIRM_MS)
      } else {
        state.recovery_phase = 'cooldown'
        state.recovery_next_at = iso(nextAt ?? deadline)
      }
      return true
    }
    if (state.recovery_phase === 'confirming' && firstPass != null) {
      if (nextAt != null) return false
      state.recovery_next_at = iso(firstPass + QUALITY_RECOVERY_CONFIRM_MS)
      return true
    }
    if (state.recovery_phase === 'cooldown' && nextAt != null) return false
    // Legacy or inconsistent record: one quiet period from the last valid answer.
    state.recovery_phase = 'cooldown'
    state.recovery_first_pass_at = null
    state.recovery_next_at = iso(deadline)
    return true
  }

  snapshot() {
    const saved = this.read({ recover: true })
    return {
      mode: !saved.config.enabled
        ? 'manual'
        : saved.config.interval_minutes === 60
          ? 'hourly'
          : saved.config.interval_minutes === 1440
            ? 'daily'
            : 'custom',
      model: saved.config.model,
      running: this.progress.running,
      config: saved.config,
      progress: { ...this.progress, active_vm_ids: [...this.progress.active_vm_ids] },
      items: codexRecords(this.projectRoot).map((vm) => {
        const identity = accountIdentity(this.projectRoot, vm.id)
        const state = saved.states[vm.id]?.account_identity === identity ? { ...saved.states[vm.id] } : emptyResult()
        state.recovery_history = Array.isArray(state.recovery_history)
          ? state.recovery_history.map((row) => ({ ...row }))
          : []
        delete state.account_identity
        return {
          vm_id: vm.id,
          vm_name: vm.name || null,
          ...state,
          paused: isQualityPause(vm),
          result: state.last_result,
          wrong: state.consecutive_wrong,
          due: parseMs(state.recovery_next_at),
          first_pass: parseMs(state.recovery_first_pass_at),
          last_at: parseMs(state.last_test_at),
          request_id: state.last_request_id || null,
        }
      }),
    }
  }

  saveConfig(input) {
    const saved = this.read()
    if (input && Object.hasOwn(input, 'mode')) {
      const mode = input.mode
      if (!['manual', 'daily', 'hourly'].includes(mode)) throw probeError('invalid_quality_mode', '无效的探测频率')
      input = { ...saved.config, enabled: mode !== 'manual', interval_minutes: mode === 'daily' ? 1440 : 60 }
    }
    const config = normalizeQualityProbeConfig(input)
    const changedQuestion = ['model', 'prompt', 'expected_answer'].some((key) => config[key] !== saved.config[key])
    if (changedQuestion) {
      const now = this.now()
      const paused = new Set(
        codexRecords(this.projectRoot)
          .filter(isQualityPause)
          .map((vm) => vm.id),
      )
      for (const id of Object.keys(saved.states)) {
        const previous = saved.states[id] || {}
        const state = { ...emptyResult() }
        state.last_dispatched_at = previous.last_dispatched_at
        state.last_request_id = previous.last_request_id
        if (previous.account_identity) state.account_identity = previous.account_identity
        if (Array.isArray(previous.recovery_history))
          state.recovery_history = previous.recovery_history.slice(-RECOVERY_HISTORY_LIMIT)
        // A first pass measured the old question; it is not evidence for the new one.
        if (paused.has(id)) {
          state.quality_pause_trigger = previous.quality_pause_trigger || 'answer'
          this.armCooldown(state, now)
        }
        saved.states[id] = state
      }
      for (const id of paused) {
        if (saved.states[id]) continue
        saved.states[id] = { ...emptyResult(), account_identity: accountIdentity(this.projectRoot, id) }
        this.armCooldown(saved.states[id], now)
      }
      for (const id of paused) {
        pushHistory(
          saved.states[id],
          recoveryEntry(now, 'config_changed', null, saved.states[id].recovery_next_at, null),
        )
        logRecovery(id, 'config_changed', null, iso(now), saved.states[id].recovery_next_at)
      }
    }
    saved.config = config
    saved.next_run_at = new Date(this.now() + config.interval_minutes * 60_000).toISOString()
    this.settings().set(QUALITY_PROBE_KEY, saved)
    // An answer started with the previous settings is not evidence for the new settings.
    this.revision++
    this.arm()
    return this.snapshot()
  }

  resetAccount(vmId) {
    if (!isCodexVm(getVm(this.projectRoot, vmId))) return
    const saved = this.read()
    const identity = accountIdentity(this.projectRoot, vmId)
    const previous = saved.states[vmId]
    const state = { ...emptyResult(), account_identity: identity }
    if (previous?.account_identity === identity && Array.isArray(previous.recovery_history)) {
      // A manual reset is an event in this account's journal, not a reason to forget it.
      state.last_dispatched_at = previous.last_dispatched_at
      state.last_request_id = previous.last_request_id
      state.recovery_history = previous.recovery_history.slice(-RECOVERY_HISTORY_LIMIT)
      pushHistory(state, recoveryEntry(this.now(), 'manual_reset', null, null, null))
      logRecovery(vmId, 'manual_reset', null, iso(this.now()), null)
    }
    // A pause that is still in place needs a fresh quiet period before the next re-test.
    const now = this.now()
    if (isQualityPause(getVm(this.projectRoot, vmId))) {
      this.armCooldown(state, now)
      pushHistory(state, recoveryEntry(now, 'cooldown', null, state.recovery_next_at, null))
      logRecovery(vmId, 'cooldown', null, iso(now), state.recovery_next_at)
    }
    saved.states[vmId] = state
    this.settings().set(QUALITY_PROBE_KEY, saved)
  }

  start() {
    if (!this.isOwner()) return
    this.started = true
    this.stopping = false
    this.arm()
  }

  reload() {
    this.revision++
    this.arm()
  }

  async stop() {
    this.stopping = true
    this.started = false
    clearTimeout(this.timer)
    this.timer = null
    this.wake = null
    this.progress.next_run_at = null
    await this.running
  }

  arm() {
    clearTimeout(this.timer)
    this.timer = null
    this.wake = null
    this.progress.next_run_at = null
    if (!this.started || this.stopping || !this.isOwner() || this.running) return
    const saved = this.read({ recover: true })
    if (!saved.config.enabled) return
    const now = this.now()
    const normal =
      parseMs(saved.next_run_at) != null
        ? saved.next_run_at
        : new Date(now + saved.config.interval_minutes * 60_000).toISOString()
    saved.next_run_at = normal
    this.settings().set(QUALITY_PROBE_KEY, saved)
    this.progress.next_run_at = normal
    // Wake for whichever comes first: the normal cadence or the next quality recovery.
    const recoveryAt = this.nextRecoveryAt(saved)
    const recoveryOnly = recoveryAt != null && recoveryAt < Date.parse(normal)
    const at = recoveryOnly ? iso(recoveryAt) : normal
    this.wake = { at, recoveryOnly }
    this.timer = setTimeout(
      () => {
        try {
          const recoveryOnlyWake = this.wake?.recoveryOnly === true
          void this.runNow({ recoveryOnly: recoveryOnlyWake }).catch(() => console.warn('[quality-probe] round failed'))
        } catch {
          this.arm()
        }
      },
      Math.max(1000, Date.parse(at) - now),
    )
    this.timer.unref?.()
  }

  /** Earliest scheduled recovery among the accounts that are quality paused right now. */
  nextRecoveryAt(saved) {
    let earliest = null
    for (const vm of codexRecords(this.projectRoot)) {
      if (!isQualityPause(vm)) continue
      const at = parseMs(this.stateFor(vm.id, saved).recovery_next_at)
      if (at == null) continue
      if (earliest == null || at < earliest) earliest = at
    }
    return earliest
  }

  /** Saved state of this account, or a blank one when the evidence belongs to another account. */
  stateFor(vmId, saved = this.read()) {
    const state = saved.states?.[vmId]
    if (!state || typeof state !== 'object') return emptyResult()
    return state.account_identity === accountIdentity(this.projectRoot, vmId) ? state : emptyResult()
  }

  recoveryDue(state, now = this.now()) {
    if (!state || state.recovery_phase === 'recovered') return false
    const due = parseMs(state.recovery_next_at)
    return due == null ? true : due <= now
  }

  runNow({ recoveryOnly = false, manual = false } = {}) {
    if (this.stopping || !this.isOwner()) throw probeError('owner_unavailable', '后台维护进程不可用')
    if (this.running) throw probeError('quality_probe_busy', '探测正在进行')
    if (!this.read().config.enabled && !(this.guarded && manual))
      throw probeError('quality_probe_disabled', '请先启用答题探测')
    clearTimeout(this.timer)
    this.timer = null
    this.wake = null
    this.progress.next_run_at = null
    this.running = this.runRound({ recoveryOnly }).finally(() => {
      this.running = null
      this.progress.running = false
      this.progress.current_vm_id = null
      this.progress.active_count = 0
      this.progress.active_vm_ids = []
      this.progress.finished_at = new Date(this.now()).toISOString()
      this.arm()
    })
    return this.running
  }

  async runRound({ recoveryOnly = false } = {}) {
    const saved = this.read({ recover: true })
    const { config } = saved
    const revision = this.revision
    const started = this.now()
    const accounts = codexRecords(this.projectRoot)
    // A recovery wake only ever re-tests a due quality pause: no healthy account,
    // and the normal cadence keeps its own deadline.
    const queue = accounts
      .map((vm) => ({ id: vm.id, recovery: isQualityPause(vm) }))
      .filter((task) =>
        recoveryOnly ? task.recovery && this.recoveryDue(this.stateFor(task.id, saved), started) : true,
      )
    if (!recoveryOnly) {
      saved.next_run_at = new Date(started + config.interval_minutes * 60_000).toISOString()
      this.settings().set(QUALITY_PROBE_KEY, saved)
    }
    this.progress = {
      running: true,
      total: queue.length,
      completed: 0,
      current_vm_id: null,
      active_count: 0,
      active_vm_ids: [],
      started_at: new Date(started).toISOString(),
      finished_at: null,
      next_run_at: null,
    }
    // Stop dispatching on shutdown, ownership loss or a settings change, but let
    // every already-dispatched probe settle before the round reports done.
    let failed = false
    const live = () => !failed && !this.stopping && this.isOwner() && revision === this.revision
    // One shared queue: an account is probed at most once per round, and a
    // finished account frees its slot immediately instead of a batch wait.
    const worker = async () => {
      while (live()) {
        const task = queue.shift()
        if (!task) return
        try {
          await this.probeAccount(task.id, config, live, task.recovery)
        } catch (error) {
          failed = true
          throw error
        }
      }
    }
    const limit = Math.min(config.concurrency, queue.length)
    const settled = await Promise.allSettled(Array.from({ length: limit }, () => worker()))
    const failure = settled.find((result) => result.status === 'rejected')
    if (failure) throw failure.reason
    if (!recoveryOnly && revision === this.revision && this.isOwner()) {
      const saved = this.read()
      saved.next_run_at = new Date(
        Math.max(
          this.now() + 1000,
          started + config.interval_minutes * 60_000,
          ...Object.values(saved.states).map((state) =>
            this.guarded && !state.recovery_phase
              ? (parseMs(state.last_dispatched_at) || 0) + config.interval_minutes * 60_000
              : 0,
          ),
        ),
      ).toISOString()
      this.settings().set(QUALITY_PROBE_KEY, saved)
    }
  }

  async probeAccount(vmId, config, live, recovery) {
    const vm = getVm(this.projectRoot, vmId)
    if (!vm || !isCodexVm(vm)) {
      this.progress.completed++
      return
    }
    const identity = accountIdentity(this.projectRoot, vmId)
    if (this.guarded && !recovery && config.enabled) {
      const previous = parseMs(this.stateFor(vmId).last_dispatched_at)
      if (previous != null && this.now() < previous + config.interval_minutes * 60000) {
        this.progress.completed++
        return
      }
    }
    if (recovery) {
      // Cooldown and stage come from the persisted state, never from this wake-up.
      if (!this.recoveryDue(this.stateFor(vmId, this.read()))) {
        this.progress.completed++
        return
      }
      const blocked = this.skipReason(vm, config, { recovery: true })
      if (blocked) {
        // Not a measurement: it still burns the first pass and defers the next attempt.
        this.record(vmId, { result: 'blocked', answer: null, error: blocked }, config, identity, { recovery: true })
        this.progress.completed++
        return
      }
      this.markProbing(vmId)
      this.markActive(vmId)
      try {
        const result = await this.measure(vmId, config)
        if (!live()) return
        this.settleMeasurement(vmId, result, config, identity, true)
        this.progress.completed++
      } finally {
        this.probing.delete(vmId)
        this.unmarkActive(vmId)
      }
      return
    }
    const skip = this.skipReason(vm, config)
    if (skip) {
      // A quality pause keeps its actual failing answer visible, not a later "skipped" record.
      if (vm?.schedule_disabled_reason !== QUALITY_PROBE_PAUSE_REASON)
        this.record(vmId, { result: 'skipped', answer: null, error: skip }, config, identity)
      this.progress.completed++
      return
    }
    this.markActive(vmId)
    try {
      const result = await this.measure(vmId, config)
      if (!live()) return
      this.settleMeasurement(vmId, result, config, identity, false)
      this.progress.completed++
    } finally {
      this.unmarkActive(vmId)
    }
  }

  settleMeasurement(vmId, result, config, identity, recovery) {
    const vm = getVm(this.projectRoot, vmId)
    if (!vm || !isCodexVm(vm) || readCodexAccounts(this.projectRoot, vmId).length > 1) return
    if (accountIdentity(this.projectRoot, vmId) !== identity) this.resetAccount(vmId)
    else this.record(vmId, result, config, identity, { recovery })
  }

  /** One pinned answer, judged. Authentication recovery belongs to the owner, not this test. */
  async measure(vmId, config) {
    try {
      // Persist the intent before crossing the local gateway or the paid upstream.
      const requestId = 'codex-quality-' + randomUUID()
      const saved = this.read()
      saved.states[vmId] = {
        ...this.stateFor(vmId, saved),
        account_identity: accountIdentity(this.projectRoot, vmId),
        last_dispatched_at: iso(this.now()),
        last_request_id: requestId,
        pending_request_id: requestId,
      }
      this.settings().set(QUALITY_PROBE_KEY, saved)
      const answer = await this.runTest(vmId, {
        requestId,
        model: config.model,
        prompt: `${config.prompt}\n\n${/^-?\d+$/.test(config.expected_answer) ? '只输出一个整数，不要解释。' : '只输出最终答案，不要解释或添加 Markdown 格式。'}`,
        reasoning_effort: 'medium',
        timeoutMs: 60_000,
        personaMode: 'overwrite',
        // Authentication recovery belongs to the owner, not this quality test.
        allowCredentialRefresh: false,
      })
      if ((answer?.ok && answer.vm_id !== vmId) || (answer?.debug?.hit_vm && answer.debug.hit_vm !== vmId)) {
        return { result: 'invalid', answer: null, error: '执行账号与探测目标不一致' }
      }
      const signal = answer?.debug?.safety_buffering
      return {
        ...evaluateQualityProbeResult(answer, config.expected_answer),
        safety_buffering: typeof signal === 'boolean' ? signal : null,
        safety_buffering_enabled: answer?.debug?.safety_buffering_enabled ?? null,
        safety_buffering_faster_model: answer?.debug?.safety_buffering_faster_model ?? null,
        upstream_model: answer?.debug?.upstream_model ?? null,
        safety_pause: answer?.vm_id === vmId && signal === true && !/(^|[-/])luna($|[-/])/i.test(config.model),
      }
    } catch {
      return { result: 'error', answer: null, error: '探测请求失败或超时，不计答错' }
    }
  }

  /** Persist the in-flight stage so a restart resumes it instead of hanging on it. */
  markProbing(vmId) {
    this.probing.add(vmId)
    const saved = this.read()
    const identity = accountIdentity(this.projectRoot, vmId)
    const state = saved.states[vmId]?.account_identity === identity ? saved.states[vmId] : null
    if (!state || !isQualityPause(getVm(this.projectRoot, vmId))) return
    const now = this.now()
    state.recovery_phase = 'probing'
    pushHistory(state, recoveryEntry(now, 'probing', null, null, null))
    logRecovery(vmId, 'probing', null, iso(now), null)
    this.settings().set(QUALITY_PROBE_KEY, saved)
  }

  markActive(vmId) {
    if (this.progress.active_vm_ids.includes(vmId)) return
    this.progress.active_vm_ids.push(vmId)
    this.progress.active_count = this.progress.active_vm_ids.length
    this.progress.current_vm_id = this.progress.active_vm_ids[0]
  }

  unmarkActive(vmId) {
    const ids = this.progress.active_vm_ids.filter((id) => id !== vmId)
    this.progress.active_vm_ids = ids
    this.progress.active_count = ids.length
    this.progress.current_vm_id = ids[0] ?? null
  }

  skipReason(vm, config, { recovery = false } = {}) {
    if (!vm) return '账号已移除'
    if (recovery) {
      if (!isQualityPause(vm)) return '账号已不在答题暂停状态'
    } else if (vm.schedule_off || vm.schedulable === false) return '账号已暂停或不可调度'
    if (readCodexAccounts(this.projectRoot, vm.id).length > 1) return '槽内有多个账号，无法归属质量结果，本轮跳过'
    if (openAIRuntimeSignals(vm.id).inFlight > 0) return '账号正在处理业务请求，本轮跳过'
    return this.poolEligible(vm, config, { recovery }) ? null : '账号受凭证、代理、额度、模型或时段限制，本轮跳过'
  }

  /**
   * Normal pool eligibility. A recovery probe may bypass ONLY this quality 调度关;
   * unschedulable, holds, credentials, proxy, quota and rest hours still apply.
   */
  poolEligible(vm, config, { recovery = false } = {}) {
    const summary = { ...vm, ...summarizeVm(vm, this.projectRoot) }
    if (recovery && isQualityPause(vm)) {
      const unschedulable = vm.unschedulable?.reason || null
      const hold = vm.schedule_hold?.reason || null
      summary.schedule_off = false
      summary.schedule_manual = false
      summary.schedulable = !unschedulable && !hold
      summary.schedule_disabled_reason = unschedulable || hold
    }
    const available = orderCodexSessionSlots([summary], {
      model: config.model,
      quotaPolicy: this.getQuotaPolicy(),
      now: this.now(),
      roundRobinCursor: 0,
    })
    // `ids` also lists a parked quota fallback; a re-test needs a genuinely ready slot.
    return (available.ready || []).includes(vm.id) && available.ids.includes(vm.id)
  }

  /** One judged answer for one account; the only writer of account state. */
  record(vmId, result, config, identity, { recovery = false } = {}) {
    const now = this.now()
    const saved = this.read()
    const previous = saved.states[vmId]?.account_identity === identity ? saved.states[vmId] : null
    const base = previous || emptyResult()
    const state = {
      ...emptyResult(),
      ...base,
      account_identity: identity,
      recovery_history: Array.isArray(base.recovery_history) ? [...base.recovery_history] : [],
      consecutive_wrong:
        result.result === 'correct' && !recovery
          ? 0
          : (base.consecutive_wrong || 0) + (result.result === 'wrong' ? 1 : 0),
    }
    // A blocked recovery is not a measurement: the failing answer stays visible.
    if (!['blocked', 'skipped'].includes(result.result)) state.pending_request_id = null
    if (result.result !== 'blocked') {
      state.last_result = result.result
      state.last_answer = result.answer ?? null
      state.last_error = result.error ?? null
      state.last_test_at = iso(now)
      if (result.result !== 'skipped') {
        state.safety_buffering = result.safety_buffering ?? null
        state.safety_buffering_enabled = result.safety_buffering_enabled ?? null
        state.safety_buffering_faster_model = result.safety_buffering_faster_model ?? null
        state.upstream_model = result.upstream_model ?? null
        state.signal_test_at = iso(now)
        console.info(
          '[quality-probe-measurement]',
          JSON.stringify({
            vm_id: vmId,
            at: iso(now),
            result: result.result,
            requested_model: config.model,
            upstream_model: state.upstream_model,
            safety_buffering: state.safety_buffering,
            safety_buffering_enabled: state.safety_buffering_enabled,
            safety_buffering_faster_model: state.safety_buffering_faster_model,
            safety_pause: result.safety_pause === true,
          }),
        )
      }
    }
    if (recovery) this.applyRecovery(vmId, state, previous, result, now)
    else if (result.safety_pause || (result.result === 'wrong' && state.consecutive_wrong >= config.failure_threshold))
      this.pauseForQuality(vmId, state, result, now)
    saved.states[vmId] = state
    this.settings().set(QUALITY_PROBE_KEY, saved)
  }

  /** 调度关 for this account only; an operator/auth pause that arrived first wins. */
  pauseForQuality(vmId, state, result, now) {
    const vm = getVm(this.projectRoot, vmId)
    if (!vm || vm.schedule_off || vm.schedulable === false) return
    setScheduleOff(this.projectRoot, vmId, true, { reason: QUALITY_PROBE_PAUSE_REASON })
    state.quality_pause_trigger = result.safety_pause ? 'safety_buffering' : 'answer'
    this.armCooldown(state, now)
    pushHistory(
      state,
      recoveryEntry(
        now,
        'paused',
        result.safety_pause ? 'safety_buffering' : result.result,
        state.recovery_next_at,
        state.quality_pause_trigger,
      ),
    )
    logRecovery(
      vmId,
      'paused',
      result.safety_pause ? 'safety_buffering' : result.result,
      iso(now),
      state.recovery_next_at,
    )
  }

  armCooldown(state, now) {
    state.recovery_phase = 'cooldown'
    state.recovery_first_pass_at = null
    state.recovery_next_at = iso(now + QUALITY_RECOVERY_RETRY_MS)
  }

  /** Judge one recovery attempt; the caller already re-read the account identity. */
  applyRecovery(vmId, state, previous, result, now) {
    // Re-read the actual pause: an operator/auth change may have landed mid-probe.
    const vm = getVm(this.projectRoot, vmId)
    if (!isQualityPause(vm)) {
      state.recovery_phase = null
      state.recovery_first_pass_at = null
      state.recovery_next_at = null
      pushHistory(state, recoveryEntry(now, 'aborted', result.result, null, '账号已不在答题暂停状态'))
      logRecovery(vmId, 'aborted', result.result, iso(now), null)
      return
    }
    const phase = previous?.recovery_phase || null
    const firstPass = parseMs(previous?.recovery_first_pass_at)
    // 'probing' is the persisted mark of this very attempt, so it keeps its stage.
    const confirming = firstPass != null && (phase === 'confirming' || phase === 'probing')
    if (result.result === 'correct' && !result.safety_pause && confirming) {
      // Second consecutive correct answer: lift ONLY this quality pause and keep every
      // other restriction (unschedulable, hold, credentials, quota, rest hours).
      setScheduleOff(this.projectRoot, vmId, false, { preserveStatus: true, preserveUnschedulable: true })
      state.recovery_phase = 'recovered'
      state.recovery_first_pass_at = null
      state.recovery_next_at = null
      state.consecutive_wrong = 0
      state.quality_pause_trigger = null
      pushHistory(state, recoveryEntry(now, 'recovered', 'correct', null, null))
      logRecovery(vmId, 'recovered', 'correct', iso(now), null)
      return
    }
    if (result.result === 'correct' && !result.safety_pause) {
      // First pass updates the result but keeps the pause and wrong count.
      const nextAt = now + QUALITY_RECOVERY_CONFIRM_MS
      state.recovery_phase = 'confirming'
      state.recovery_first_pass_at = iso(now)
      state.recovery_next_at = iso(nextAt)
      pushHistory(state, recoveryEntry(now, 'first_pass', 'correct', nextAt, null))
      logRecovery(vmId, 'first_pass', 'correct', iso(now), iso(nextAt))
      return
    }
    // Anything else is no evidence: drop the first pass and wait another quiet period.
    this.armCooldown(state, now)
    if (result.safety_pause) state.quality_pause_trigger = 'safety_buffering'
    const event = result.result === 'blocked' || result.result === 'skipped' ? 'blocked' : 'retry'
    const outcome = result.safety_pause ? 'safety_buffering' : result.result
    pushHistory(
      state,
      recoveryEntry(
        now,
        event,
        outcome,
        state.recovery_next_at,
        result.safety_pause ? '非 Luna 请求明确触发安全缓冲' : result.error,
      ),
    )
    logRecovery(vmId, event, outcome, iso(now), state.recovery_next_at)
  }
}

function accountIdentity(projectRoot, vmId) {
  const account = enrichCodexAccountIdentity(readCodexAccounts(projectRoot, vmId)[0] || {})
  const email = String(account.email || '')
    .trim()
    .toLowerCase()
  const accountId = String(account.chatgpt_account_id || '').trim()
  // Ordinary token rotation must retain a known account's score. Without identity,
  // a credential change safely starts over rather than attributing an old answer.
  const identity =
    email || accountId
      ? ['account', email, accountId]
      : ['credentials', account.access_token || '', account.refresh_token || '']
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

function probeError(code, message) {
  return Object.assign(new Error(message), { code, status: 409 })
}

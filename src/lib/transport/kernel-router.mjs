/**
 * Request-level inference hop router.
 * 公开仓只走 rust cli-hop（kernel → Claude Code）。Go HTTP 转发不再启用。
 * Credential import/ensure 仍可走 Go 客户端，但不参与推理 hop。
 */
import { setTimeout as delay } from 'node:timers/promises'
import { clientCancelledResult, isClientCancelledResult } from '../core/errors.mjs'
import { ensureWorkerCredential } from './go-worker-client.mjs'
import { ensureOfficialCredentialLink, slotUidGidFromHomeDir } from '../oauth/oauth-credentials.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { vmNodeId } from '../cluster/placement.mjs'
import {
  streamRustKernel,
  callRustKernel,
  rustKernelHealth,
  rustKernelHealthTimeoutMs,
  rustKernelReachable,
  rustKernelBusy,
  isNeedsRefreshResult,
  kernelFaults,
} from './rust-kernel-client.mjs'
import {
  kernelBinPath,
  awaitWrapRecycle,
  noteWrapHop,
  beginWrapHop,
  endWrapHop,
  wrapHopInflight,
} from './rust-kernel-supervisor.mjs'

const rustHealthCache = new Map()
const DEFAULT_SLOT_WAIT_MS = 30_000
const DEFAULT_SLOT_POLL_MS = 200
const REMOTE_HEALTH_RECHECK_MS = 6000
const HEALTH_TRANSPORT_ERRORS = new Set(['worker_timeout', 'ECONNRESET', 'EPIPE', 'ECONNREFUSED'])

export function rustHealthTtlMs(routing = {}) {
  const raw = routing?.inference?.health_ttl_ms
  if (raw == null || raw === '') return 2000
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 2000
  return n
}

export function rustSlotWaitMs(routing = {}) {
  const raw = routing?.inference?.slot_wait_ms
  if (raw == null || raw === '') return DEFAULT_SLOT_WAIT_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SLOT_WAIT_MS
  return n
}

/** Hop slot poll uses leftover wait-plan budget; never stacks a second independent 30s. */
export function resolveHopSlotWaitMs({ remainingBudgetMs, routing } = {}) {
  const configuredRaw = routing?.inference?.slot_wait_ms
  const hasConfigured = configuredRaw != null && configuredRaw !== ''
  const configured = hasConfigured ? rustSlotWaitMs(routing) : null
  const budget = Number(remainingBudgetMs)
  const hasBudget = remainingBudgetMs != null && remainingBudgetMs !== '' && Number.isFinite(budget)
  if (hasBudget) {
    if (budget <= 0) return 0
    if (configured != null) return Math.min(budget, configured)
    return budget
  }
  return rustSlotWaitMs(routing)
}

export function rustShouldWaitForSlot(health, inflight = 0) {
  return rustKernelBusy(health) || Number(inflight) > 0
}

function slotBudgetExhausted(health) {
  return { ok: false, reason: 'slot_busy', health, error: 'rust kernel slot admission budget exhausted' }
}

export async function waitForReadySlot(
  exec,
  timeoutMs = DEFAULT_SLOT_WAIT_MS,
  pollMs = DEFAULT_SLOT_POLL_MS,
  { signal } = {},
) {
  const parsed = Number(timeoutMs)
  const waitMs = Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULT_SLOT_WAIT_MS
  const deadline = Date.now() + waitMs
  const gap = Math.max(40, Number(pollMs) || DEFAULT_SLOT_POLL_MS)
  let last
  let first = true
  while (Date.now() < deadline && !signal?.aborted) {
    last = await rustKernelHealth(exec, {
      timeoutMs: Math.min(rustKernelHealthTimeoutMs(exec?.vm, 400), Math.max(1, deadline - Date.now())),
      signal,
    })
    if (signal?.aborted || Date.now() >= deadline) break
    if (rustKernelReachable(last)) return { ok: true, reason: first ? 'already_up' : 'slot_ready', health: last }
    first = false
    try {
      await delay(Math.min(gap, deadline - Date.now()), undefined, { signal })
    } catch (error) {
      if (!signal?.aborted) throw error
    }
  }
  return signal?.aborted ? clientCancelledResult({ upstreamExecutions: 0 }) : slotBudgetExhausted(last)
}

export function clearRustHealthCache(vmId = null) {
  if (vmId) rustHealthCache.delete(String(vmId))
  else rustHealthCache.clear()
}

function cacheKey(exec) {
  return String(exec?.vmId || exec?.vm?.id || '')
}

export function rememberRustHealth(exec, ready, at = Date.now()) {
  const key = cacheKey(exec)
  if (!key || !ready?.ok) return
  rustHealthCache.set(key, { at, health: ready.health || null, maxAgeMs: ready.maxAgeMs ?? Infinity })
}

/** Share a new admission probe, never renew the scheduler's cached observation. */
export async function probeRustHealth(exec, { remainingBudgetMs, ...options } = {}) {
  let at = Date.now()
  const budget = Number(remainingBudgetMs)
  const deadline = remainingBudgetMs != null && Number.isFinite(budget) ? at + Math.max(0, budget) : Infinity
  if (at >= deadline) return { ok: false, status: 0, code: 'worker_timeout', error: 'health probe budget exhausted' }
  const initialOptions = Number.isFinite(deadline)
    ? { ...options, timeoutMs: Math.min(options.timeoutMs ?? 3000, Math.max(1, deadline - at)) }
    : options
  let health = await rustKernelHealth(exec, initialOptions)
  if (
    vmNodeId(exec?.vm) &&
    !options.signal?.aborted &&
    health?.status === 0 &&
    HEALTH_TRANSPORT_ERRORS.has(health?.code) &&
    Date.now() < deadline
  ) {
    // Only GET /health is repeated. Never infer a dead CLI from a lost SSH reply.
    const firstCode = health.code
    at = Date.now()
    health = await rustKernelHealth(exec, {
      ...options,
      timeoutMs: Math.min(REMOTE_HEALTH_RECHECK_MS, deadline - at),
    })
    console.warn(
      '[kernel-health]',
      JSON.stringify({
        vm_id: cacheKey(exec),
        first_code: firstCode,
        final_status: health?.status || 0,
        ready: rustKernelReachable(health),
        recheck_ms: Date.now() - at,
      }),
    )
  }
  const key = cacheKey(exec)
  if (key && health?.ok === true && health.vm_id === key && rustKernelReachable(health)) {
    rememberRustHealth(exec, { ok: true, health, maxAgeMs: 2000 }, at)
  } else if (key) clearRustHealthCache(key)
  return health
}

export function peekRustHealth(exec, ttlMs, now = Date.now()) {
  if (ttlMs <= 0) return null
  const key = cacheKey(exec)
  if (!key) return null
  const hit = rustHealthCache.get(key)
  if (!hit) return null
  if (now < hit.at || now - hit.at > Math.min(ttlMs, hit.maxAgeMs)) return null
  return hit
}

export function resolveHopEngine(vm, _routing = {}, { rustReady = null, binPath = null } = {}) {
  const wanted = 'rust'
  // A baked slot image carries its own kernel; the host binary only matters for local mounts.
  const bin = slotHost(vm).bakedKernel ? 'image' : binPath != null ? String(binPath).trim() : kernelBinPath()
  if (rustReady === true) {
    return { engine: 'rust', wanted, reason: 'configured_rust', fallback: false }
  }
  if (rustReady === false || !bin) {
    return {
      engine: 'rust',
      wanted,
      reason: rustReady === false ? 'rust_unhealthy' : 'bin_missing',
      fallback: false,
      blocked: true,
    }
  }
  return { engine: 'rust', wanted, reason: 'configured_rust', fallback: false }
}

function rustUnavailableResult(ready) {
  // Admission failed before inference; another allowed VM may be selected.
  const answered = ready?.reason === 'slot_busy' || ready?.reason === 'kernel_unavailable'
  return {
    ok: false,
    status: answered ? 503 : 0,
    via: 'rust-kernel',
    engine: 'rust',
    body: {
      type: 'error',
      error: {
        type: 'worker_error',
        code: ready?.reason || 'rust_unavailable',
        message: ready?.error || 'rust kernel is not available',
      },
    },
    headers: {},
    terminalState: answered ? 'rejected' : 'transport_error',
    transportError: !answered,
    committed: false,
    upstreamExecutions: 0,
  }
}

function credentialEnsureFailure(result, ensured) {
  const rawError = ensured?.error
  const error = rawError && typeof rawError === 'object' ? rawError : {}
  const blob = `${error.code || ''} ${error.message || ''} ${typeof rawError === 'string' ? rawError : ''}`
  const fatal = /invalid_grant|oauth_revoked|token has been revoked|refresh_token_missing/i.test(blob)
  const revoked = /token has been revoked|oauth_revoked/i.test(blob)
  return {
    ...result,
    ok: false,
    status: fatal ? 401 : Number(ensured?.status) || result.status,
    committed: fatal ? false : result.committed,
    terminalState: fatal ? 'rejected' : result.terminalState,
    body: {
      type: 'error',
      error: {
        type: fatal ? 'authentication_error' : error.type || 'worker_error',
        code: fatal
          ? revoked
            ? 'oauth_revoked'
            : error.code || 'invalid_grant'
          : error.code || 'credential_refresh_failed',
        message: fatal
          ? revoked
            ? 'OAuth access token has been revoked'
            : 'OAuth credential was rejected'
          : String(error.message || rawError || 'credential ensure failed').slice(0, 300),
      },
    },
    credential_ensure_failed: true,
  }
}

async function prepareSlotCredentials(exec) {
  if (!exec?.homeDir) return
  const ids = slotUidGidFromHomeDir(exec.homeDir)
  ensureOfficialCredentialLink(exec.homeDir, ids || {})
}

async function prepareRust(exec, { ensure, routing, slotWaitMs, signal } = {}) {
  const started = Date.now()
  const budget =
    slotWaitMs != null && slotWaitMs !== '' && Number.isFinite(Number(slotWaitMs))
      ? Math.max(0, Number(slotWaitMs))
      : Infinity
  const expired = () => Date.now() - started >= budget
  if (signal?.aborted) return clientCancelledResult({ upstreamExecutions: 0 })
  if (expired()) return slotBudgetExhausted()
  await awaitWrapRecycle(exec)
  if (signal?.aborted) return clientCancelledResult({ upstreamExecutions: 0 })
  if (expired()) return slotBudgetExhausted()
  const fault = kernelFaults.get(cacheKey(exec))
  if (fault) return { ok: false, reason: 'kernel_unavailable', error: fault }
  if (typeof ensure === 'function') {
    const ready = await ensure(exec)
    return expired() ? slotBudgetExhausted() : ready
  }
  await prepareSlotCredentials(exec)
  if (expired()) return slotBudgetExhausted()
  const ttl = rustHealthTtlMs(routing)
  const cached = peekRustHealth(exec, ttl)
  if (cached && rustKernelReachable(cached.health)) {
    return { ok: true, reason: 'health_cache', health: cached.health }
  }
  const health = await probeRustHealth(exec, {
    timeoutMs: rustKernelHealthTimeoutMs(exec?.vm),
    remainingBudgetMs: Number.isFinite(budget) ? Math.max(0, budget - (Date.now() - started)) : undefined,
    signal,
  })
  if (signal?.aborted) return clientCancelledResult({ upstreamExecutions: 0 })
  if (expired()) return slotBudgetExhausted(health)
  if (rustKernelReachable(health)) {
    const ready = { ok: true, reason: 'already_up', health }
    return ready
  }
  // The kernel spent its own CLI restarts, or the watchdog spent its container
  // restarts. Only the watchdog restarts it, bounded; a request must not.
  if (health?.healthy === false) {
    return {
      ok: false,
      reason: 'kernel_unavailable',
      error: health?.unhealthy_reason || 'rust kernel unhealthy',
    }
  }
  if (rustShouldWaitForSlot(health, wrapHopInflight(exec))) {
    const waitMs = Math.max(
      0,
      resolveHopSlotWaitMs({ remainingBudgetMs: slotWaitMs, routing }) - (Date.now() - started),
    )
    const waited = await waitForReadySlot(exec, waitMs, DEFAULT_SLOT_POLL_MS, { signal })
    if (waited?.ok) {
      rememberRustHealth(exec, waited)
      return waited
    }
    return waited
  }
  clearRustHealthCache(cacheKey(exec))
  return {
    ok: false,
    reason: 'kernel_unavailable',
    error: `rust kernel health probe failed (${health?.code || health?.status || 'unavailable'}); inference was not dispatched`,
  }
}

async function runHop({ mode, opts }) {
  const routing = opts.routing || {}
  const decision = resolveHopEngine(opts.exec?.vm, routing)
  let engine = 'rust'
  let reason = decision.reason
  if (!decision.blocked) {
    const ready = await prepareRust(opts.exec, {
      ensure: opts.ensureRust,
      routing,
      slotWaitMs: opts.slotWaitMs,
      signal: opts.signal,
    })
    if (opts.signal?.aborted) return clientCancelledResult({ upstreamExecutions: 0 })
    if (ready?.ok) {
      if (opts.requestContext && opts.cliHop && ready.health?.classifier_request_context !== true) {
        return {
          ok: false,
          status: 400,
          terminalState: 'rejected',
          upstreamExecutions: 0,
          body: {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              code: 'classifier_runtime_unsupported',
              message: 'The kernel/CLI runtime does not support classifier request context.',
            },
          },
        }
      }
      reason = ready.reason || 'configured_rust'
    } else {
      return {
        ...rustUnavailableResult(ready),
        wanted_engine: 'rust',
        engine_reason: ready?.reason || 'rust_unavailable',
      }
    }
  } else {
    return {
      ...rustUnavailableResult({ reason: decision.reason }),
      wanted_engine: 'rust',
      engine_reason: decision.reason,
    }
  }
  const send = mode === 'stream' ? streamRustKernel : callRustKernel
  beginWrapHop(opts.exec)
  let result
  try {
    result = await send(opts)
    noteWrapHop(opts.exec)
    if (opts.signal?.aborted || isClientCancelledResult(result)) {
      result = clientCancelledResult(result)
    } else if (result.transportError === true && result.committed === false && result.upstreamExecutions === 0) {
      result = await send(opts)
      result = { ...result, rust_transport_retried: true }
      noteWrapHop(opts.exec)
    }
    if (!isClientCancelledResult(result) && isNeedsRefreshResult(result)) {
      const ensure = opts.ensureCredential || ensureWorkerCredential
      const ensured = await ensure(opts.exec, { force: true })
      if (ensured?.ok !== true) result = credentialEnsureFailure(result, ensured)
      else {
        // The CLI invalidates its OAuth cache from the shared credential file
        // before creating each API client. Recycling here kills sibling hops.
        result = await send(opts)
        result = { ...result, credential_retried: true }
        noteWrapHop(opts.exec)
      }
    }
    return {
      ...result,
      engine,
      wanted_engine: decision.wanted,
      engine_reason: reason,
    }
  } finally {
    endWrapHop(opts.exec)
    // Inference failures only invalidate health. The watchdog owns container
    // recovery, so concurrent requests cannot bypass its restart budget.
    if (result?.transportError || result?.body?.error?.code === 'kernel_unavailable') {
      clearRustHealthCache(cacheKey(opts.exec))
    }
  }
}

export function dispatchStreamInference(opts = {}) {
  return runHop({ mode: 'stream', opts })
}

export function dispatchCallInference(opts = {}) {
  return runHop({ mode: 'call', opts })
}

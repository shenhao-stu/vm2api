import { writeJsonIfChanged } from '../vm/vm-file.mjs'
/**
 * Host-side Codex kernel lifecycle. Dedicated Codex VMs listen on
 * vms/<id>/run/codex-kernel.sock; Claude workers are never reused.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { boundProxyUrl, isLocalEgressProxy, localEgressProxyUrl } from '../vm/egress.mjs'
import { vmNodeId } from '../cluster/placement.mjs'
import { assertProxyAllowed } from '../vm/proxy-policy.mjs'
import { exitGuardError, getProxyExitGuardPolicy } from '../vm/proxy-exit-guard.mjs'
import { maxRequestBytes } from '../core/config.mjs'
import { openAIRuntimeSignals } from '../pool/openai-account-runtime.mjs'
import { codexKernelHealth, codexKernelPaths } from './codex-kernel-client.mjs'
import { computedUpstreamTransport, normalizeCodexRouting } from '../protocol/codex-route.mjs'

const starts = new Map()
const stops = new Map()

function assertCodexExitSupported() {
  if (getProxyExitGuardPolicy(null).required) throw exitGuardError('exit_guard_unsupported_platform')
}

// A healthy kernel is a local process this control plane spawned. Its health
// answer is reused for a very short window so a burst of requests (and its
// failover retries) does not pay a Unix-socket roundtrip each time. Anything
// else on the request path (proxy binding, account gate, quota, model/request
// rewrite) stays untouched by this cache.
const healthCache = new Map()
const healthProbes = new Map()
const kernelGenerations = new Map()
const HEALTH_TTL_MS = 2000
// Cold starts become healthy in tens of milliseconds; the first polls are
// shorter than the steady 100ms so a warm-up does not add a flat 100ms. The
// loop still stops at the caller's deadline and never busy-spins.
const HEALTH_POLL_DELAYS_MS = [20, 40, 80]
const HEALTH_POLL_DELAY_MS = 100
const HEALTH_PROBE_TIMEOUT_MS = 500

// The kernel exits only through config.proxy_url; inherited proxy variables would give it a second, unseen exit.
function kernelEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(https?|all|no)_proxy$/i.test(key)))
}

function existingBin(candidate) {
  const bin = String(candidate || '').trim()
  if (!bin) return ''
  try {
    fs.accessSync(bin, fs.constants.X_OK)
    return bin
  } catch {
    return ''
  }
}

export function codexKernelBinPath() {
  const env = existingBin(process.env.KIN_CODEX_KERNEL_BIN)
  if (env) return env
  const kernel = String(process.env.KIN_KERNEL_BIN || process.env.KIN_API_KERNEL_BIN || '').trim()
  if (kernel) {
    const sibling = existingBin(path.join(path.dirname(kernel), 'kin-codex-kernel'))
    if (sibling) return sibling
  }
  return existingBin(path.resolve('bin/kin-codex-kernel'))
}

/** Per-hop policy keeps settings live without interrupting another request's kernel. */
export function codexKernelRequestOptions(routing = {}) {
  const codex = normalizeCodexRouting(routing.codex)
  return {
    upstream_transport: computedUpstreamTransport(routing),
    user_agent: codex.user_agent,
    client_features: codex.client_features.enabled === true,
    analytics: codex.analytics.enabled === true,
  }
}

export function writeCodexKernelConfig(projectRoot, vm, { token, proxyUrl, proxyRequired, routing } = {}) {
  assertCodexExitSupported()
  if (!projectRoot || !vm?.id) return null
  assertProxyAllowed(vm.proxy)
  if (proxyUrl) assertProxyAllowed({ url: proxyUrl })
  const runDir = path.join(projectRoot, 'vms', vm.id, 'run')
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const socketPath = path.join(runDir, 'codex-kernel.sock')
  const configPath = path.join(runDir, 'codex-kernel.json')
  const tokenPath = path.join(runDir, 'internal.token')
  const credentialPath = path.join(projectRoot, 'vms', vm.id, 'codex-credentials.json')
  let secret = String(token || '').trim()
  if (!secret) {
    try {
      secret = fs.readFileSync(tokenPath, 'utf8').trim()
    } catch {}
  }
  if (!secret) secret = crypto.randomBytes(24).toString('hex')
  writeJsonIfChanged(tokenPath, secret + '\n', { mode: 0o600 })
  const local = isLocalEgressProxy(vm?.proxy)
  // Only a slot on this host treats local egress as the deployment proxy.
  // A node slot is handed that node's forwarder; replacing it would exit from here.
  const hostLocal = local && !vmNodeId(vm)
  const proxy = hostLocal ? localEgressProxyUrl() : String(proxyUrl || boundProxyUrl(vm?.proxy) || '').trim()
  // A configured deployment proxy is this slot's exit: fail closed instead of going direct.
  const required = hostLocal ? !!proxy : proxyRequired == null ? !!proxy : !!proxyRequired
  const installationPath = path.join(runDir, 'codex-installation-id')
  let deviceId = ''
  try {
    deviceId = fs.readFileSync(installationPath, 'utf8').trim()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  // Official installation identity is a random UUID, never a VM or hardware fingerprint.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
    deviceId = crypto.randomUUID()
    fs.writeFileSync(installationPath, `${deviceId}\n`, { mode: 0o600 })
  }
  const config = {
    vm_id: vm.id,
    device_id: deviceId,
    socket_path: socketPath,
    credential_path: credentialPath,
    proxy_url: proxy,
    proxy_required: required,
    internal_token: secret,
    max_request_bytes: maxRequestBytes(routing),
    ...codexKernelRequestOptions(routing),
    test_endpoints: process.env.KIN_CODEX_TEST_ENDPOINTS === '1',
  }
  writeJsonIfChanged(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  return { runDir, socketPath, configPath, credentialPath, tokenPath, installationId: deviceId }
}

export function shouldRecycleCodexKernel({ wanted, stamped, inFlight } = {}) {
  return wanted > 0 && stamped > 0 && wanted !== stamped && inFlight <= 1
}

function limitStampPath(configPath) {
  return configPath ? path.join(path.dirname(configPath), 'codex-kernel.limit') : ''
}

function readLimitStamp(configPath) {
  try {
    return Number(fs.readFileSync(limitStampPath(configPath), 'utf8')) || 0
  } catch {
    return 0
  }
}

function writeLimitStamp(configPath, bytes) {
  if (!configPath || !(bytes > 0)) return
  fs.writeFileSync(limitStampPath(configPath), `${bytes}\n`, { mode: 0o600 })
}

function configRequestBytes(configPath) {
  try {
    return Number(JSON.parse(fs.readFileSync(configPath, 'utf8')).max_request_bytes) || 0
  } catch {
    return 0
  }
}

function childHasExited(child) {
  return !child?.pid || child.exitCode != null || child.signalCode != null
}

function normalizeHealthTtl(value) {
  if (value == null || value === '') return HEALTH_TTL_MS
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.min(ms, HEALTH_TTL_MS)
}

function kernelGeneration(vmId) {
  return kernelGenerations.get(vmId) || 0
}

/** A new process generation can never be served by an older health answer. */
function bumpKernelGeneration(vmId) {
  if (!vmId) return 0
  const next = kernelGeneration(vmId) + 1
  kernelGenerations.set(vmId, next)
  healthCache.delete(vmId)
  return next
}

/** Forget health after a transport failure without touching the process or account. */
export function invalidateCodexKernelHealth(vmId) {
  // Fence pending probes too, so an older answer cannot undo invalidation.
  bumpKernelGeneration(vmId)
}

/** Drop the cached answer, but never one that already belongs to a newer process. */
function forgetKernelHealth(vmId, child = null, generation = null) {
  const entry = vmId ? healthCache.get(vmId) : null
  if (!entry) return
  if (child && entry.child !== child) return
  if (generation != null && entry.generation !== generation) return
  healthCache.delete(vmId)
}

/**
 * Stat only: changes to config, token or the socket itself require a fresh
 * probe. Include paths and inode so atomic replacement cannot reuse health.
 */
function kernelHealthIdentity(paths = {}) {
  const stamp = (file, socket = false) => {
    if (!file) return null
    try {
      const stats = fs.statSync(file, { bigint: true })
      if (socket && !stats.isSocket()) return null
      return [file, String(stats.dev), String(stats.ino), String(stats.size), String(stats.mtimeNs)]
    } catch {
      return null
    }
  }
  const stamps = [stamp(paths.configPath), stamp(paths.tokenPath), stamp(paths.socketPath, true)]
  return stamps.every(Boolean) ? JSON.stringify(stamps) : null
}

function healthSnapshot(exec) {
  const vmId = exec?.vmId
  const paths = codexKernelPaths(exec)
  return {
    vmId,
    child: starts.get(vmId),
    generation: kernelGeneration(vmId),
    paths,
    identity: kernelHealthIdentity(paths),
  }
}

function rememberKernelHealth(snapshot, health) {
  const { vmId, child, generation, paths, identity } = snapshot
  if (!vmId || health?.ok !== true || !identity) return
  // Only a kernel this process spawned and still owns is reusable. An
  // untracked socket may belong to a previous control plane or be replaced.
  if (!child || childHasExited(child) || starts.get(vmId) !== child) return
  if (generation !== kernelGeneration(vmId)) return
  // The answer belongs to the files observed BEFORE this probe. A changed
  // config/socket during await must not be stamped healthy by an old reply.
  if (kernelHealthIdentity(paths) !== identity) return
  healthCache.set(vmId, {
    child,
    generation,
    identity,
    at: Date.now(),
    health,
  })
}

/**
 * Short bounded reuse of a healthy answer. Every identity component and the
 * owning live child must still match, and the socket must still exist.
 */
function cachedKernelHealth(exec, healthTtlMs) {
  const ttl = normalizeHealthTtl(healthTtlMs)
  const vmId = exec?.vmId
  if (!(ttl > 0) || !vmId) return null
  const entry = healthCache.get(vmId)
  if (!entry) return null
  const child = starts.get(vmId)
  if (!child || entry.child !== child || childHasExited(child)) {
    healthCache.delete(vmId)
    return null
  }
  if (entry.generation !== kernelGeneration(vmId)) {
    healthCache.delete(vmId)
    return null
  }
  if (kernelHealthIdentity(codexKernelPaths(exec)) !== entry.identity || Date.now() - entry.at >= ttl) {
    healthCache.delete(vmId)
    return null
  }
  return entry.health
}

/**
 * One socket roundtrip at a time per identical kernel. Concurrent request
 * paths share the probe, but each waits at most for its own deadline and sees
 * the failure itself, so a caller is never extended or blinded.
 */
function sharedKernelHealth(exec, deadline) {
  const remaining = deadline - Date.now()
  if (!(remaining > 0)) return Promise.resolve(null)
  const snapshot = healthSnapshot(exec)
  const key = JSON.stringify([snapshot.vmId, snapshot.generation, snapshot.paths, snapshot.identity])
  let probe = healthProbes.get(key)
  if (!probe) {
    probe = codexKernelHealth(exec, { timeoutMs: HEALTH_PROBE_TIMEOUT_MS })
      .catch((error) => ({ ok: false, reason: 'health_error', error: String(error?.message || error) }))
      .then((health) => ({ health, snapshot }))
    healthProbes.set(key, probe)
    const clear = () => {
      if (healthProbes.get(key) === probe) healthProbes.delete(key)
    }
    probe.then(clear, clear)
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), remaining)
    probe.then(finish)
  })
}

function trackKernelChild(vmId, child) {
  starts.set(vmId, child)
  bumpKernelGeneration(vmId)
  // An exit or spawn error invalidates immediately; the next call re-probes.
  const dropped = () => {
    if (starts.get(vmId) !== child) return
    bumpKernelGeneration(vmId)
    if (childHasExited(child)) starts.delete(vmId)
  }
  child.once('exit', dropped)
  child.once('error', dropped)
}

function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(true)
  if (!(timeoutMs > 0)) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(exited)
    }
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs)
    child.once('exit', () => finish(true))
  })
}

/** SIGTERM, then SIGKILL. Unlink the socket only after the process is actually gone. */
export async function finishCodexRecycle(child, socketPath, { termMs = 2000, killMs = 1000 } = {}) {
  if (!childHasExited(child)) {
    try {
      child.kill('SIGTERM')
    } catch {}
  }
  let exited = await waitForChildExit(child, termMs)
  if (!exited && killMs > 0) {
    try {
      child.kill('SIGKILL')
    } catch {}
    exited = await waitForChildExit(child, killMs)
  }
  if (!exited) return { exited: false }
  if (socketPath) {
    try {
      fs.unlinkSync(socketPath)
    } catch {}
  }
  return { exited: true }
}

/** Explicit reload must stop the host process, not just its slot container. */
export function stopCodexKernelAndWait(exec, opts = {}) {
  const vmId = exec?.vmId
  if (stops.has(vmId)) return stops.get(vmId)
  const pending = (async () => {
    bumpKernelGeneration(vmId)
    const child = starts.get(vmId)
    const paths = codexKernelPaths(exec)
    if (!child) {
      const health = await codexKernelHealth(exec, { timeoutMs: 500 })
      if (health.code === 'ENOENT' || health.code === 'ECONNREFUSED') return { ok: true, stopped: false }
      // A prior Node process may have left a detached kernel. Do not unlink a
      // listening socket or claim success when we cannot verify its owner's exit.
      return { ok: false, reason: 'untracked_kernel' }
    }
    const gone = await finishCodexRecycle(child, paths.socketPath, opts)
    if (!gone.exited) return { ok: false, reason: 'recycle_timeout' }
    if (starts.get(vmId) === child) starts.delete(vmId)
    return { ok: true, stopped: true }
  })()
  const settled = pending.finally(() => {
    if (stops.get(vmId) === settled) stops.delete(vmId)
  })
  stops.set(vmId, settled)
  return settled
}

export async function ensureCodexKernel(exec, { timeoutMs = 8000, healthTtlMs = HEALTH_TTL_MS } = {}) {
  assertCodexExitSupported()
  const stopping = stops.get(exec?.vmId)
  if (stopping) {
    const stopped = await stopping
    if (!stopped.ok) return stopped
  }
  const bin = codexKernelBinPath()
  if (!bin) return { ok: false, reason: 'bin_missing' }
  const paths = codexKernelPaths(exec)
  if (!paths.configPath) return { ok: false, reason: 'config_missing' }
  const wanted = configRequestBytes(paths.configPath)
  const stamped = readLimitStamp(paths.configPath)
  const inFlight = openAIRuntimeSignals(exec.vmId).inFlight
  // Only the request that holds this seat may recycle. A timeout is not an
  // exit: leave the socket and the tracked child in place.
  if (shouldRecycleCodexKernel({ wanted, stamped, inFlight })) {
    const child = stopCodexKernel(exec.vmId)
    if (child) {
      const gone = await finishCodexRecycle(child, paths.socketPath)
      if (!gone.exited) {
        starts.set(exec.vmId, child)
        return { ok: false, reason: 'recycle_timeout' }
      }
    }
  }
  // Reuse a recent healthy answer for a kernel this process still owns. The
  // proxy write, account gate and quota checks already ran on this request;
  // only the liveness roundtrip is skipped.
  const cached = cachedKernelHealth(exec, healthTtlMs)
  if (cached) return { ok: true, reused: true, cached: true, health: cached }
  // A genuinely cold slot has no process or socket to become healthy. Spawn
  // it immediately instead of spending the preflight budget probing ENOENT.
  // Existing sockets still get checked, including an untracked live kernel.
  if (!childHasExited(starts.get(exec.vmId)) || (paths.socketPath && fs.existsSync(paths.socketPath))) {
    const live = await waitForHealth(exec, Math.min(800, Math.max(200, Number(timeoutMs) || 800)))
    if (live.ok) return { ok: true, reused: true, health: live.health }
  }
  const current = starts.get(exec.vmId)
  if (!childHasExited(current)) return waitForHealth(exec, timeoutMs)
  try {
    if (paths.socketPath) fs.unlinkSync(paths.socketPath)
  } catch {}
  const child = spawn(bin, [paths.configPath], {
    env: kernelEnv(),
    stdio: 'ignore',
    detached: true,
  })
  child.unref()
  trackKernelChild(exec.vmId, child)
  writeLimitStamp(paths.configPath, wanted)
  return waitForHealth(exec, timeoutMs)
}

async function waitForHealth(exec, timeoutMs) {
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 8000)
  const vmId = exec?.vmId
  const child = starts.get(vmId)
  const generation = kernelGeneration(vmId)
  let last = { ok: false, reason: 'not_ready' }
  let polls = 0
  while (Date.now() < deadline) {
    const probed = await sharedKernelHealth(exec, deadline)
    // null means this caller's deadline passed while waiting.
    if (!probed) break
    last = probed.health
    if (last?.ok !== true) forgetKernelHealth(vmId, probed.snapshot.child, probed.snapshot.generation)
    if (last?.ok || Number(last?.status) === 200) {
      rememberKernelHealth(probed.snapshot, last)
      return { ok: true, health: last }
    }
    const delay = HEALTH_POLL_DELAYS_MS[polls] ?? HEALTH_POLL_DELAY_MS
    polls += 1
    const remaining = deadline - Date.now()
    if (!(remaining > 0)) break
    await new Promise((r) => setTimeout(r, Math.min(delay, remaining)))
  }
  forgetKernelHealth(vmId, child, generation)
  return { ok: false, reason: 'health_timeout', health: last }
}

export function stopCodexKernel(vmId) {
  bumpKernelGeneration(vmId)
  const child = starts.get(vmId)
  if (child) {
    try {
      child.kill('SIGTERM')
    } catch {}
    starts.delete(vmId)
  }
  return child || null
}

/** A child this process spawned for the VM that has not exited (it may still be starting or hung). */
export function codexKernelTracked(vmId) {
  return !childHasExited(starts.get(vmId))
}

export function stopAllCodexKernels() {
  for (const vmId of [...starts.keys()]) stopCodexKernel(vmId)
}

/** Stop only tracked children, with the same bounded recycle protocol as reload. */
export async function stopAllCodexKernelsAndWait() {
  await Promise.all(
    [...starts.entries()].map(async ([vmId, child]) => {
      bumpKernelGeneration(vmId)
      const result = await finishCodexRecycle(child, null)
      if (!result.exited) throw new Error('codex_kernel_stop_timeout')
      if (starts.get(vmId) === child) starts.delete(vmId)
    }),
  )
}

import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { getDb, isDbOpen } from '../db/database.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { socksProxyUrl } from './socks-address.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { proxyRequiresExitIp } from './exit-guard-policy.mjs'

export const EXIT_GUARD_MAX_AGE_MS = 30_000

export function getProxyExitGuardConfig() {
  if (!isDbOpen()) return { required: false, proxies: {} }
  const settings = new SettingsRepo(getDb())
  if (!settings.has('proxy_exit_guard')) return { required: false, proxies: {} }
  const config = settings.get('proxy_exit_guard')
  if (
    !config ||
    typeof config.required !== 'boolean' ||
    !config.proxies ||
    typeof config.proxies !== 'object' ||
    Array.isArray(config.proxies)
  ) {
    throw exitGuardError('exit_guard_config_invalid')
  }
  return config
}

export function getProxyExitGuardPolicy(proxyId, config = getProxyExitGuardConfig()) {
  const policy = config.proxies?.[proxyId]
  return {
    required: proxyRequiresExitIp(config, proxyId),
    expected_ip: typeof policy?.expected_ip === 'string' ? policy.expected_ip : '',
    revision: typeof policy?.revision === 'string' ? policy.revision : '',
  }
}

export function proxyExitGuardDirectory(projectRoot, proxyId) {
  if (!projectRoot || !/^[a-zA-Z0-9_-]+$/.test(String(proxyId || ''))) throw exitGuardError('exit_guard_proxy_required')
  return path.join(projectRoot, 'data', 'run', 'egress', String(proxyId))
}

export function proxyExitGuardStatePath(projectRoot, proxyId) {
  return path.join(proxyExitGuardDirectory(projectRoot, proxyId), 'exit-guard-state.json')
}

export function exitGuardError(reason) {
  return Object.assign(new Error(`出口 IP 校验未放行: ${reason}`), { code: 'exit_guard_blocked', reason, status: 409 })
}

const isLocal = (proxy) =>
  proxy?.scheme === 'local' || proxy?.host === 'local' || /^px-local(?:-|$)/.test(proxy?.id || '')

export function exitGuardConfigForProxy(projectRoot, proxy, config = getProxyExitGuardConfig()) {
  const policy = getProxyExitGuardPolicy(proxy?.id, config)
  if (!policy.required) return null
  if (isLocal(proxy) || proxy?.node_id) throw exitGuardError('exit_guard_unsupported_exit')
  return {
    expected_ip: policy.expected_ip,
    revision: policy.revision,
    state_path: proxyExitGuardStatePath(projectRoot, proxy?.id),
  }
}

function liveHelper(projectRoot, proxyId, pid) {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    const dir = proxyExitGuardDirectory(projectRoot, proxyId)
    if (Number(fs.readFileSync(path.join(dir, 'egress.pid'), 'utf8').trim()) !== pid) return false
    if (path.basename(fs.readlinkSync(`/proc/${pid}/exe`)) !== 'kin-egress') return false
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    const index = args.indexOf('-config')
    if (index < 0 || path.resolve(args[index + 1] || '') !== path.join(dir, 'egress.json')) return false
    const status = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '')
    return !/^[ZX]/.test(status)
  } catch {
    return false
  }
}

function canonicalIp(value) {
  const family = typeof value === 'string' ? net.isIP(value) : 0
  if (family === 4) return value
  if (family !== 6 || value.includes('%')) return null
  const address = new URL(`http://[${value}]/`).hostname.slice(1, -1)
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(address)
  if (!mapped) return address
  const high = parseInt(mapped[1], 16),
    low = parseInt(mapped[2], 16)
  return [high >> 8, high & 255, low >> 8, low & 255].join('.')
}

export function evaluateProxyExitGuardState(state, policy, { now = Date.now(), processActive = false } = {}) {
  const result = {
    required: policy.required,
    ready: false,
    latched: state?.latched === true,
    reason: 'exit_guard_unverified',
    expected_ip: policy.expected_ip,
    observed_ip: canonicalIp(state?.observed_ip) ? state.observed_ip : '',
    revision: policy.revision,
    checked_at: typeof state?.checked_at === 'string' ? state.checked_at : null,
    socks_addr: '',
  }
  if (!policy.required) return { ...result, ready: true, reason: 'exit_guard_disabled' }
  if (!canonicalIp(policy.expected_ip) || !policy.revision) return { ...result, reason: 'exit_ip_required' }
  if (!state) return result
  if (state.expected_ip !== policy.expected_ip || state.revision !== policy.revision)
    return { ...result, reason: 'exit_guard_policy_changed' }
  const age = now - Date.parse(state.checked_at)
  if (!state.latched && state.reason === 'exit_guard_checking' && processActive && age >= 0 && age <= 10_000) {
    return { ...result, reason: 'exit_guard_checking' }
  }
  // This is a live monitor's temporary network pause, never permission to
  // bypass verification. A dead/stale helper must still trigger enforcement.
  if (
    !state.latched &&
    state.reason === 'exit_guard_retrying' &&
    processActive &&
    age >= 0 &&
    age <= EXIT_GUARD_MAX_AGE_MS
  ) {
    return { ...result, reason: 'exit_guard_retrying' }
  }
  if (state.latched || state.ready !== true) {
    return {
      ...result,
      reason:
        !['exit_guard_checking', 'exit_guard_retrying'].includes(state.reason) &&
        /^exit_(?:ip|guard)_[a-z_]+$/.test(state.reason || '')
          ? state.reason
          : 'exit_guard_unverified',
    }
  }
  if (canonicalIp(state.observed_ip) !== canonicalIp(policy.expected_ip))
    return { ...result, reason: 'exit_ip_mismatch' }
  if (!processActive) return { ...result, reason: 'exit_guard_not_running' }
  if (!Number.isFinite(age) || age < 0 || age > EXIT_GUARD_MAX_AGE_MS) return { ...result, reason: 'exit_guard_stale' }
  if (!/^127\.0\.0\.1:[0-9]+$/.test(state.socks_addr || '')) return { ...result, reason: 'exit_guard_bad_listener' }
  const port = Number(state.socks_addr.split(':')[1])
  if (port < 1 || port > 65535) return { ...result, reason: 'exit_guard_bad_listener' }
  return { ...result, ready: true, reason: 'verified', socks_addr: state.socks_addr }
}

export function getProxyExitGuardState(projectRoot, proxyId) {
  const policy = getProxyExitGuardPolicy(proxyId)
  let state = null
  try {
    state = JSON.parse(fs.readFileSync(proxyExitGuardStatePath(projectRoot, proxyId), 'utf8'))
  } catch {}
  return evaluateProxyExitGuardState(state, policy, { processActive: liveHelper(projectRoot, proxyId, state?.pid) })
}

export function guardedProxyUrl(projectRoot, proxy) {
  const policy = getProxyExitGuardPolicy(proxy?.id)
  if (!policy.required) return socksProxyUrl(proxy)
  exitGuardConfigForProxy(projectRoot, proxy)
  const state = getProxyExitGuardState(projectRoot, proxy?.id)
  if (!state.ready) throw exitGuardError(state.reason)
  return `socks5h://${state.socks_addr}`
}

export function exitGuardVmRejection(vm) {
  if (!getProxyExitGuardPolicy(vm?.proxy?.id).required) return null
  const code = isCodexVm(vm) ? 'exit_guard_unsupported_platform' : vm?.node_id ? 'exit_guard_unsupported_exit' : null
  return code ? { ok: false, status: 409, code, error: code } : null
}

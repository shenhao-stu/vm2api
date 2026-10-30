/**
 * Resolve a usable SOCKS5 URL for sessionKey conversion.
 * Prefer the pool's internal credentials; never read username/password
 * from the redacted public snapshot.
 *
 * Local egress (`px-local`) is a bound exit with no SOCKS URL: the route of
 * the VPS that runs the slot. A local slot's import and host hops use the
 * control-plane default route (`direct: true`, a Codex slot carries the
 * deployment proxy its kernel also uses); a node slot's leave from that node
 * through its SSH link. That is not "unbound".
 */
import { boundProxyUrl, isLocalEgressProxy } from './egress.mjs'
import { slotHost } from './slot-host.mjs'
import { configuredIpv6Enabled, proxyBlockedReason } from './proxy-policy.mjs'
import {
  clusterGuardedEgressEnabled,
  exitGuardError,
  getProxyExitGuardPolicy,
  guardedProxyUrl,
} from './proxy-exit-guard.mjs'
import { isCodexVm } from './vm-kind.mjs'

function poolHitForVm(proxyPool, vm) {
  if (!proxyPool || typeof proxyPool.snapshot !== 'function') return null
  const list = proxyPool.snapshot()?.proxies || []
  const id = vm?.proxy?.id || vm?.proxy_id
  const vmId = vm?.id
  return (
    list.find((p) => {
      if (id && p.id === id) return true
      if (!vmId) return false
      if (p.bound_vm_id === vmId) return true
      return Array.isArray(p.bound_vm_ids) && p.bound_vm_ids.includes(vmId)
    }) || null
  )
}

function socksUrlFromVm(vm) {
  const px = vm?.proxy
  if (!px) return null
  return boundProxyUrl(px) || null
}

export function poolProxyUnavailable(hit) {
  if (!hit) return false
  if (hit.blocked_reason) return true
  // Direct exit. A stale fail/dead from the old kin-egress probe is not "no proxy".
  if (isLocalEgressProxy(hit)) return hit.enabled === false
  return !hit.enabled || hit.status === 'dead' || hit.status === 'fail'
}

export function resolveImportProxy({ vm, proxyPool, overrideUrl = null, projectRoot } = {}) {
  let hit, allocated
  try {
    hit = poolHitForVm(proxyPool, vm)
    allocated = vm?.id && typeof proxyPool?.getProxyForVm === 'function' ? proxyPool.getProxyForVm(vm.id) : null
    if (getProxyExitGuardPolicy(allocated?.id || hit?.id || vm?.proxy?.id).required) {
      if (overrideUrl) throw exitGuardError('exit_guard_override_forbidden')
      if (isCodexVm(vm)) throw exitGuardError('exit_guard_unsupported_platform')
      if (vm?.node_id && !clusterGuardedEgressEnabled()) throw exitGuardError('exit_guard_unsupported_exit')
      if (poolProxyUnavailable(hit)) throw exitGuardError('exit_guard_proxy_unavailable')
      const proxyUrl = guardedProxyUrl(projectRoot, allocated || hit || vm?.proxy)
      return { ok: true, proxyUrl, blocked: false, reason: null }
    }
  } catch (error) {
    return {
      ok: false,
      proxyUrl: null,
      blocked: true,
      code: 'exit_guard_blocked',
      reason: error.reason || 'exit_guard_unverified',
      status: 409,
    }
  }
  const ipv6Enabled = proxyPool?.snapshot?.().config?.ipv6_enabled ?? configuredIpv6Enabled()
  const blocked = proxyBlockedReason(overrideUrl ? { url: overrideUrl } : hit || vm?.proxy, ipv6Enabled)
  if (blocked || hit?.blocked_reason) {
    return { ok: false, proxyUrl: null, blocked: true, reason: blocked || hit.blocked_reason }
  }
  if (poolProxyUnavailable(hit)) {
    return { ok: false, proxyUrl: null, blocked: true, reason: 'proxy_unavailable' }
  }
  if (overrideUrl) {
    return { ok: true, proxyUrl: boundProxyUrl({ url: overrideUrl }), blocked: false, reason: null }
  }
  if (isLocalEgressProxy(hit) || isLocalEgressProxy(allocated) || isLocalEgressProxy(vm?.proxy)) {
    let proxyUrl
    try {
      proxyUrl = slotHost(vm).localExitProxyUrl(vm)
    } catch {
      // A node exit without its forwarder must not quietly become the control plane's route.
      return { ok: false, proxyUrl: null, blocked: true, reason: 'proxy_unavailable' }
    }
    return { ok: true, proxyUrl, blocked: false, reason: null, direct: true }
  }
  if (allocated?.url) {
    return {
      ok: true,
      proxyUrl: String(allocated.url).replace(/^socks5:\/\//i, 'socks5h://'),
      blocked: false,
      reason: null,
    }
  }
  const fallback = socksUrlFromVm(vm)
  if (fallback) return { ok: true, proxyUrl: fallback, blocked: false, reason: null }
  return { ok: false, proxyUrl: null, blocked: false, reason: 'proxy_required' }
}

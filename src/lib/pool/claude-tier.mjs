import { isInventedFableWindow } from '../oauth/crs-usage-probe.mjs'

function quotaView(vm = {}, quota = {}) {
  return {
    utilization_7d_oi: quota.utilization_7d_oi ?? vm.utilization_7d_oi,
    reset_7d_oi: quota.reset_7d_oi || vm.reset_7d_oi,
    status_7d_oi: quota.status_7d_oi || vm.status_7d_oi,
    '7d_oi': quota['7d_oi'] || vm['7d_oi'],
    usage_has_fable: quota.usage_has_fable ?? vm.usage_has_fable,
  }
}

/** Fable usage is an entitlement signal; promotions can also grant it to Pro. */
export function hasClaudeFableUsage(vm = {}, quota = {}) {
  const q = quotaView(vm, quota)
  if (q.usage_has_fable != null) return q.usage_has_fable === true
  const fb = quota.fable || vm.fable || {}
  const oi = q['7d_oi'] || {}
  const hasOi =
    q.utilization_7d_oi != null ||
    q.reset_7d_oi ||
    q.status_7d_oi ||
    oi.utilization != null ||
    oi.reset ||
    oi.resets_at ||
    oi.status
  if (!hasOi) return false
  return !isInventedFableWindow(fb, q)
}

/** Explicit Pro must survive temporary Fable access, including refusal-guard scoping. */
export function inferClaudeTier(vm = {}, quota = {}) {
  const hasToken = !!(vm.has_token || vm.has_access)
  if (!hasToken) return { key: 'none', label: null }
  const q = quotaView(vm, quota)
  if ([vm.account_tier, quota.account_tier].some((tier) => String(tier || '').toLowerCase() === 'pro'))
    return { key: 'pro', label: 'Pro' }
  if (q.usage_has_fable === false) return { key: 'pro', label: 'Pro' }
  const stored = String(vm.account_tier || quota.account_tier || '').toLowerCase()
  if (hasClaudeFableUsage(vm, quota) || stored === 'max') {
    return { key: 'max', label: 'Max' }
  }
  if (stored === 'pro') {
    return { key: 'pro', label: 'Pro' }
  }
  return { key: 'pro', label: 'Pro' }
}

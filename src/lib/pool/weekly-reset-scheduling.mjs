import { listQuotaFromHeaders, parseResetMs } from './quota-window.mjs'
import { protectsClaudePro } from '../protocol/refusal-session-isolation.mjs'

export function proWeeklyResetAt(vm, account) {
  return protectsClaudePro({ vm, account }) ? listQuotaFromHeaders(account?.unified).reset_7d : null
}

/** Missing or elapsed readings never retain an urgency boost or invent a new window. */
export function weeklyResetRank(resetAt, now = Date.now()) {
  const at = parseResetMs(resetAt)
  return at > now ? at : Number.POSITIVE_INFINITY
}

export function weeklyResetProbeTarget(vm, account) {
  if (!protectsClaudePro({ vm, account }) || vm.status !== 'running' || vm.schedule_manual) return false
  if (vm.claude?.refresh_error || ['error', 'disabled', 'revoked'].includes(account?.status)) return false
  const reason = String(vm.schedule_disabled_reason || vm.temp_unschedulable_reason || '')
  return !(vm.schedulable === false || reason) || /^(quota|five_hour|seven_day|usage_limit)/.test(reason)
}

export function weeklyResetProbeDue(account, now = Date.now()) {
  const reset = parseResetMs(listQuotaFromHeaders(account?.unified, { now }).reset_7d)
  if (reset > now) return { due: false, reason: 'weekly_reset_future' }
  const probe = account?.last_probe || account?.unified?.last_probe
  const at = Date.parse(probe?.at || probe?.probed_at || '')
  if (Number.isFinite(at) && now - at < 15 * 60_000 && (!Number.isFinite(reset) || at >= reset))
    return { due: false, reason: 'probed_recently' }
  return { due: true, reason: Number.isFinite(reset) ? 'weekly_reset_elapsed' : 'weekly_reset_unknown' }
}

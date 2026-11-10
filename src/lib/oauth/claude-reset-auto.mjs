import { createHash } from 'node:crypto'
import { fablePromotionActive, FABLE_PROMOTION_END } from '../protocol/fable-promotion.mjs'
import { protectsClaudePro } from '../protocol/refusal-session-isolation.mjs'
import { getVm } from '../vm/vm-registry.mjs'
import { queryClaudeResetCredits, redeemClaudeResetCredit } from './claude-reset-credits.mjs'

export const RESET_EXPIRY_LEAD_MS = 15 * 60_000
const REFRESH_MS = 6 * 3600_000
const RETRY_MS = 5 * 60_000

/** Native percent_used is 0–100; subscription and model eligibility remain separate. */
export function autoResetReason(grant, now = Date.now()) {
  if (!fablePromotionActive(now) || !(grant?.resets_left > 0)) return null
  if (!grant.clears?.includes('seven_day_overage_included')) return null
  const end = Date.parse(grant.expires_at || grant.ends_at || '')
  const start = Date.parse(grant.starts_at || '')
  if (!Number.isFinite(end) || end <= now || end > FABLE_PROMOTION_END || (Number.isFinite(start) && start > now))
    return null
  if (Number(grant.percent_used?.seven_day_overage_included) >= 100) return 'fable_exhausted'
  return end - now <= RESET_EXPIRY_LEAD_MS ? 'expiring' : null
}

export function autoResetEligible(vm, account) {
  if (!protectsClaudePro({ vm, account }) || vm?.status !== 'running' || vm.schedule_manual) return false
  const reason = String(vm.schedule_disabled_reason || vm.temp_unschedulable_reason || '')
  if ((vm.schedulable === false || reason) && !/^(quota|five_hour|seven_day|fable_weekly|usage_limit)/.test(reason))
    return false
  if (vm.claude?.refresh_error || ['error', 'disabled', 'revoked'].includes(account?.status)) return false
  return true
}

export function createClaudeResetAuto({
  projectRoot,
  getConfig,
  listTargets,
  accountForVm,
  reserve,
  afterReset,
  query = queryClaudeResetCredits,
  redeem = redeemClaudeResetCredit,
  readVm = (id) => getVm(projectRoot, id),
  now = Date.now,
  log = () => {},
}) {
  const checked = new Map()
  const completed = new Set()
  let active = null
  let timer = null
  let stopped = true
  const enabled = () => getConfig()?.enabled === true && fablePromotionActive(now())
  const event = (vmId, data) => log({ event: 'claude_auto_reset', vm_id: vmId, ...data })

  async function tick() {
    if (!enabled()) return
    for (const vm of listTargets()) {
      if (stopped || !enabled()) break
      const account = accountForVm(vm)
      if (!autoResetEligible(vm, account)) continue
      const accountId = account?.account_id || vm.claude?.account_uuid || vm.account_uuid
      if (!accountId || completed.has(accountId)) continue
      const at = now()
      const credits = vm.claude_reset_credits
      const held = (credits?.credits || []).filter((g) => g.resets_left > 0)
      const oi = account?.unified?.['7d_oi'] || {}
      const full =
        (Number(oi.utilization) >= 1 || ['rejected', 'rate_limited'].includes(oi.status)) &&
        !(Date.parse(oi.reset || '') <= at)
      const urgent = held.some((g) => autoResetReason(g, at)) || (held.length > 0 && full)
      const fetched = Date.parse(credits?.fetched_at || '')
      if (!urgent && Number.isFinite(fetched) && at - fetched < REFRESH_MS) continue
      if (at - (checked.get(accountId) || 0) < RETRY_MS) continue
      // The maintenance reservation shares the account's single inference permit.
      const release = reserve(vm, account)
      if (!release) continue
      checked.set(accountId, at)
      try {
        const fresh = await query({ projectRoot, vmId: vm.id, now })
        if (!fresh.ok) {
          event(vm.id, { error: fresh.error })
          continue
        }
        const grant = fresh.claude_reset_credits?.credits?.find((g) => g.redeemable && autoResetReason(g, now()))
        if (!grant) continue
        const reason = autoResetReason(grant, now())
        const idempotencyKey = createHash('sha256')
          .update(`pro-launch:${accountId}:${FABLE_PROMOTION_END}`)
          .digest('hex')
        const result = await redeem({
          projectRoot,
          vmId: vm.id,
          idempotencyKey,
          now,
          shouldRedeem: (_block, current, at) =>
            enabled() &&
            !stopped &&
            autoResetEligible(readVm(vm.id), accountForVm(vm)) &&
            !!autoResetReason(current, at),
        })
        event(vm.id, {
          reason,
          outcome: result.outcome || null,
          error: result.error || null,
          replayed: !!result.replayed,
        })
        if (result.ok && ['reset', 'already_used', 'unknown'].includes(result.outcome)) completed.add(accountId)
        if (result.ok && result.outcome === 'reset') await afterReset(vm)
      } catch (error) {
        event(vm.id, { error: error?.code || 'auto_reset_failed' })
      } finally {
        release()
      }
    }
  }

  function runOnce() {
    if (active) return active
    active = tick().finally(() => {
      active = null
    })
    return active
  }
  return {
    start() {
      if (!stopped) return
      stopped = false
      timer = setInterval(() => {
        runOnce().catch(() => {})
      }, 60_000)
      timer.unref?.()
      return runOnce()
    },
    runOnce,
    async stop() {
      stopped = true
      clearInterval(timer)
      timer = null
      await active
    },
  }
}

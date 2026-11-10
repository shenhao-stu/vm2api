import { createHash } from 'node:crypto'

const FABLE_WINDOW = 'seven_day_overage_included'
const WINDOWS = new Set(['five_hour', 'seven_day', FABLE_WINDOW])
const DAY_MS = 24 * 60 * 60 * 1000
const CONFIRMED = new Set(['reset', 'already_used'])

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const decision = (action, reason) => ({ action, reason })

function timestamp(value) {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function windowsOf(credit) {
  return [...new Set(Array.isArray(credit?.clears) ? credit.clears.filter((key) => WINDOWS.has(key)) : [])].sort()
}

/** Public identity only. Usage, labels and query timestamps must not create new claims. */
export function claudeResetCreditFingerprint(credit) {
  if (/^[a-f0-9]{64}$/.test(credit?.fingerprint || '')) return credit.fingerprint
  return digest([
    timestamp(credit?.starts_at),
    timestamp(credit?.expires_at),
    windowsOf(credit),
    credit?.use_requires_limit === true,
  ])
}

export function claudeAutoResetKey(vmId, credit, accountFingerprint = null) {
  const namespace = /^[a-f0-9]{64}$/.test(accountFingerprint || '') ? [vmId, accountFingerprint] : [vmId]
  return `fable-auto-${digest([...namespace, claudeResetCreditFingerprint(credit), credit?.resets_left])}`
}

function usedPercent(credit, key) {
  const value = credit?.percent_used?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : 0
}

function validFableCredit(credit, now) {
  const expires = timestamp(credit?.expires_at)
  const starts = timestamp(credit?.starts_at)
  return (
    credit?.redeemable === true &&
    Number.isInteger(credit.resets_left) &&
    credit.resets_left > 0 &&
    windowsOf(credit).includes(FABLE_WINDOW) &&
    expires != null &&
    expires > now &&
    (credit.starts_at == null || (starts != null && starts <= now)) &&
    (!Array.isArray(credit.blocking) || credit.blocking.length === 0)
  )
}

/**
 * Called by the external scheduler, never a model request or an in-process timer.
 * accountReady includes native OAuth, valid credentials and operator scheduling.
 * exitReady requires the current guard revision and observed fixed exit to match.
 * Persist pending BEFORE redeem; retain unknown operations until manually reconciled.
 */
export function planClaudeFableReset({
  vmId,
  enabled = false,
  accountReady = false,
  exitReady = false,
  credits,
  fableWindow = {},
  operations = [],
  now = Date.now(),
  expiryLeadMs = DAY_MS,
  maxSnapshotAgeMs = 10 * 60 * 1000,
} = {}) {
  if (enabled !== true) return decision('skip', 'disabled')
  if (!vmId || accountReady !== true) return decision('skip', 'account_not_ready')
  if (exitReady !== true) return decision('skip', 'exit_not_ready')
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(expiryLeadMs) ||
    expiryLeadMs < 0 ||
    !Number.isFinite(maxSnapshotAgeMs) ||
    maxSnapshotAgeMs <= 0
  ) {
    return decision('blocked', 'invalid_policy_clock')
  }
  if (
    !Array.isArray(operations) ||
    operations.some(
      (op) =>
        !op ||
        !CONFIRMED.has(op.outcome) ||
        !/^[a-f0-9]{64}$/.test(op.fingerprint || '') ||
        !/^fable-auto-[a-f0-9]{64}$/.test(op.idempotency_key || '') ||
        !Number.isInteger(op.resets_left) ||
        op.resets_left <= 0,
    )
  ) {
    return decision('blocked', 'operation_needs_reconciliation')
  }
  const fetchedAt = timestamp(credits?.fetched_at)
  if (fetchedAt == null || fetchedAt > now + 5000 || now - fetchedAt > maxSnapshotAgeMs) {
    return decision('query', 'fresh_official_status_required')
  }
  if (credits?.eligible !== true) return decision('skip', 'ineligible')
  const cooldown = timestamp(credits.cooldown_until)
  if (credits.cooldown_until != null && (cooldown == null || cooldown > now)) {
    return decision('skip', 'cooldown')
  }
  const candidates = (Array.isArray(credits.credits) ? credits.credits : []).filter(
    (credit) => credit?.redeemable === true,
  )
  if (candidates.length !== 1) return decision('skip', 'no_unique_next_credit')
  const credit = candidates[0]
  if (!validFableCredit(credit, now)) return decision('skip', 'no_eligible_fable_credit')
  const fingerprint = claudeResetCreditFingerprint(credit)
  const idempotencyKey = claudeAutoResetKey(vmId, credit, credits.account_fingerprint)
  const previous = operations.filter((op) => op.fingerprint === fingerprint)
  if (
    operations.some((op) => op.idempotency_key === idempotencyKey) ||
    previous.some((op) => !Number.isInteger(op.resets_left) || credit.resets_left >= op.resets_left)
  ) {
    return decision('skip', 'await_confirmed_credit_decrement')
  }
  const fableUsed = usedPercent(credit, FABLE_WINDOW)
  const windowAt = timestamp(fableWindow.fetched_at)
  const windowReset = timestamp(fableWindow.resets_at)
  const freshWindow =
    windowAt != null &&
    windowAt <= now + 5000 &&
    now - windowAt <= maxSnapshotAgeMs &&
    (fableWindow.resets_at == null || (windowReset != null && windowReset > now))
  const exhausted = fableUsed >= 100 || (freshWindow && fableWindow.exhausted === true)
  const used = windowsOf(credit).some((key) => usedPercent(credit, key) > 0)
  const expiring = timestamp(credit.expires_at) - now <= expiryLeadMs
  if (!exhausted && !(expiring && used)) return decision('skip', 'no_reset_needed')
  return {
    action: 'redeem',
    reason: exhausted ? 'fable_limit_reached' : 'used_credit_expiring',
    idempotency_key: idempotencyKey,
    fingerprint,
    resets_left: credit.resets_left,
    expires_at: credit.expires_at,
  }
}

import { planClaudeFableReset } from '../../src/lib/oauth/claude-reset-policy.mjs'
import { inferClaudeTier } from '../../src/lib/pool/claude-tier.mjs'

const GUARD_MAX_AGE_MS = 60_000

// Audited native error paths return these before writeFence/claim. Transport
// failures, store failures and unresolved fences are deliberately not included.
const BEFORE_CLAIM_ERRORS = new Set([
  'CLAUDE_RESET_AUTO_NOT_NEEDED', 'CLAUDE_RESET_AUTO_CREDIT_CHANGED',
  'CLAUDE_RESET_PROFILE_FAILED', 'CLAUDE_RESET_QUERY_FAILED', 'CLAUDE_RESET_BUSY',
  'CLAUDE_RESET_ACCOUNT_CHANGED', 'CLAUDE_RESET_ORGANIZATION_INVALID', 'CLAUDE_RESET_STATUS_INVALID',
  'CLAUDE_RESET_TOKEN_UNAVAILABLE', 'CLAUDE_RESET_WORKER_UNSUPPORTED', 'CLAUDE_RESET_PROXY_UNAVAILABLE',
  'CLAUDE_RESET_PROFILE_SCOPE_REQUIRED', 'CLAUDE_RESET_OAUTH_REQUIRED',
])

function resetAccountReady(vm) {
  return vm?.status === 'running' && vm?.schedulable === true && vm?.can_claude_reset === true &&
    ['pro', 'max'].includes(inferClaudeTier(vm).key)
}

export function readyForReset(vm, guard, now = Date.now()) {
  const state = guard?.state
  const checked = Date.parse(state?.checked_at)
  return resetAccountReady(vm) &&
    guard?.required === true && state?.ready === true && state?.latched === false &&
    !!guard.expected_ip && state.expected_ip === guard.expected_ip && state.observed_ip === guard.expected_ip &&
    state.revision === guard.revision && Number.isFinite(checked) && checked <= now + 5000 && now - checked <= GUARD_MAX_AGE_MS
}

/** One native metadata pass; the caller serializes passes and durably saves intent before redemption. */
export async function maintainFableResets({ api, state, save, enabled = false, now = Date.now }) {
  const { items = [] } = await api('GET', '/vms')
  const { proxies = [] } = await api('GET', '/proxy-exit-guard')
  let guards = new Map(proxies.map(g => [g.id, g]))
  const reports = []
  for (const vm of items) {
    if (!enabled || !resetAccountReady(vm)) continue
    let stateKey, operations
    try {
      // A serial upstream query may outlive the first local guard snapshot.
      // Refresh only the local proof; never unlock or probe a different exit.
      if (now() - Date.parse(guards.get(vm.proxy_id)?.state?.checked_at) > GUARD_MAX_AGE_MS) {
        const fresh = await api('GET', '/proxy-exit-guard')
        guards = new Map((fresh.proxies || []).map(g => [g.id, g]))
      }
      if (!readyForReset(vm, guards.get(vm.proxy_id), now())) continue
      const result = await api('POST', `/vms/${encodeURIComponent(vm.id)}/claude-reset/query`, {})
      const accountFingerprint = result.claude_reset_credits?.account_fingerprint
      if (!/^[a-f0-9]{64}$/.test(accountFingerprint || '')) {
        reports.push({ vm_id: vm.id, action: 'blocked', reason: 'account_identity_missing' }); continue
      }
      stateKey = `${vm.id}:${accountFingerprint}`
      operations = state[stateKey] || []
      const plan = planClaudeFableReset({ vmId: vm.id, enabled, accountReady: true, exitReady: true,
        credits: result.claude_reset_credits, operations, now: now() })
      if (plan.action !== 'redeem') {
        reports.push({ vm_id: vm.id, action: plan.action, reason: plan.reason })
        continue
      }
      // Check operator state and guard again after the network query.
      const current = await api('GET', `/vms/${encodeURIComponent(vm.id)}`)
      const fresh = await api('GET', '/proxy-exit-guard')
      if (!readyForReset(current.vm, fresh.proxies.find(g => g.id === current.vm.proxy_id), now())) {
        reports.push({ vm_id: vm.id, action: 'skip', reason: 'state_changed' }); continue
      }
      const operation = { ...plan, outcome: 'pending', at: new Date(now()).toISOString() }
      state[stateKey] = [...operations, operation]
      await save(state)
      const redeemed = await api('POST', `/vms/${encodeURIComponent(vm.id)}/claude-reset/redeem`,
        { auto_reset: { account_fingerprint: accountFingerprint, fingerprint: plan.fingerprint, resets_left: plan.resets_left } },
        { 'Idempotency-Key': plan.idempotency_key })
      operation.outcome = redeemed.outcome || 'unknown'
      operation.reason = redeemed.reason || plan.reason
      await save(state)
      reports.push({ vm_id: vm.id, action: 'redeem', outcome: operation.outcome, reason: operation.reason })
    } catch (error) {
      if (stateKey && BEFORE_CLAIM_ERRORS.has(error?.code)) {
        // Native preflight proves that no claim or operation record was created.
        state[stateKey] = operations
        await save(state)
      }
      // Every other uncertain outcome retains the intent until manual reconciliation.
      reports.push({ vm_id: vm.id, action: 'error', reason: error?.code || 'native_request_failed' })
    }
  }
  return reports
}

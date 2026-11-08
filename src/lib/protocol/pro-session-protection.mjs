import { createProSessionQuarantine } from '../core/pro-session-quarantine.mjs'
import { keyAllowsVm, keyScopeFromRequest } from '../admin/key-scope.mjs'
import { credentialModeOfVm, isApiKeyMode } from '../oauth/credential-mode.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { listVms } from '../vm/vm-registry.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'

const code = 'pro_session_quarantined'
export function quarantinedResult(unavailable = false) {
  const reason = unavailable ? 'pro_session_guard_unavailable' : code
  return {
    ok: false,
    status: unavailable ? 503 : 400,
    upstreamExecutions: 0,
    preDispatchRejection: true,
    finalState: reason,
    terminalState: reason,
    body: {
      type: 'error',
      error: {
        type: unavailable ? 'api_error' : 'invalid_request_error',
        code: reason,
        message: unavailable
          ? 'Cannot verify session isolation.'
          : 'This conversation was isolated after an upstream refusal. Start a new conversation without the refused history.',
        details: { retryable: false },
      },
    },
  }
}

export function isClaudeSubscriptionSlot(vm) {
  return !!vm && !isCodexVm(vm) && !isApiKeyMode(credentialModeOfVm(vm))
}

export function proSessionProtection(req, inbound, body, deps) {
  const guard = createProSessionQuarantine({
    req,
    inbound,
    body,
    headers: req.headers,
    settings: deps.settings,
    repo: deps.proSessionQuarantineRepo,
  })
  let recorded = false
  return {
    beforeDispatch() {
      try {
        return guard.blocked() ? quarantinedResult() : null
      } catch {
        console.error('[pro-session-quarantine] could not verify the session before dispatch')
        return quarantinedResult(true)
      }
    },
    observeUpstream(value) {
      if (recorded || value?.via?.includes('-mock')) return
      try {
        recorded = guard.observe(value) === true
      } catch {
        // The first upstream response still owns its genuine terminal usage.
        console.error('[pro-session-quarantine] could not persist the upstream refusal')
      }
    },
    waitForStopReason() {
      try {
        return !recorded && guard.enabled()
      } catch {
        // The worker already ran. Preserve its receipt and wait for the terminal evidence.
        return true
      }
    },
    recorded: () => recorded,
  }
}

// Only scan membership on a positive lookup. Mixed pools must defer the
// decision until selection so an unrelated API slot keeps its policy.
export function proTargetScope(req, deps, scope = keyScopeFromRequest(req)) {
  if (!deps.cfg?.paths?.project) return 'none'
  const rawPin = String(req.headers?.['x-kin-vm'] || '').trim()
  const pin = req.apiKeyKind === 'master' && isValidVmId(rawPin) ? rawPin : ''
  const candidates = listVms(deps.cfg.paths.project).filter(
    (vm) => !isCodexVm(vm) && (!pin || vm.id === pin) && keyAllowsVm(scope, vm),
  )
  if (!candidates.some(isClaudeSubscriptionSlot)) return 'none'
  return candidates.every(isClaudeSubscriptionSlot) ? 'pro' : 'mixed'
}

/**
 * Account probe — VM UID only (CRS oauth/usage + fable).
 * Gateway process never calls Anthropic.
 */
import { probeVmUsage } from './crs-usage-probe.mjs'
import { flattenOauthIdentity } from './oauth-identity.mjs'
import { tierFromOauthProfile } from './official-cc-stats.mjs'
import { runSlotOauth } from '../transport/slot-oauth.mjs'

export async function probeAccount(opts = {}) {
  if (opts && typeof opts === 'object' && (opts.exec || opts.homeDir || opts.vm)) {
    const exec = opts.exec || {
      vmId: opts.vm?.id,
      homeDir: opts.homeDir,
      oauth: opts.vm?.claude || { access_token: opts.accessToken },
      vm: opts.vm,
    }
    const result = await (opts.probeUsage || probeVmUsage)({
      exec,
      includeFable: opts.includeFable !== false,
      timeoutMs: opts.timeoutMs,
      identity: opts.identity || null,
    })
    const stored = opts.vm?.claude || exec.vm?.claude || {}
    if (result.ok !== true || result.usage_scope_missing || (!opts.refreshSubscription && stored.subscription_type))
      return result
    let profile
    try {
      profile = await (opts.slotOauth || runSlotOauth)(exec, 'profile', { timeoutMs: opts.timeoutMs || 20000 })
    } catch {
      return { ...result, subscription_error: 'profile_unavailable' }
    }
    const identity = profile?.ok ? flattenOauthIdentity(profile.body) : null
    const sameAccount = !identity?.account_uuid || !stored.account_uuid || identity.account_uuid === stored.account_uuid
    const sameOrg = !identity?.org_uuid || !stored.org_uuid || identity.org_uuid === stored.org_uuid
    if (!sameAccount || !sameOrg) return { ...result, subscription_error: 'profile_identity_mismatch' }
    return {
      ...result,
      subscription_type: identity?.subscription_type || null,
      rate_limit_tier: identity?.rate_limit_tier || null,
      account_tier: profile?.ok ? tierFromOauthProfile(profile.body) : null,
      account_tier_source: profile?.ok ? 'profile' : null,
      subscription_error: profile?.ok ? null : profile?.body?.error?.code || `http_${profile?.status || 0}`,
    }
  }
  return {
    ok: false,
    source: 'vm-oauth-usage',
    error: 'probe_requires_vm_exec',
    probed_at: new Date().toISOString(),
  }
}

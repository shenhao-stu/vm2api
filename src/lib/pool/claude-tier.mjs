/** Subscription identity and model entitlement are separate facts. */
export function normalizeClaudeTier(value) {
  const plan = String(value || '')
    .trim()
    .toLowerCase()
  if (plan === 'pro') return 'pro'
  if (['max', 'max5x', 'max20x', 'ultra'].includes(plan)) return 'max'
  return null
}

export function claudeSubscriptionTier(record = {}) {
  const subscription = String(record.subscription_type || record.subscriptionType || '')
    .trim()
    .toLowerCase()
  if (subscription) return normalizeClaudeTier(subscription)
  const rateTier = String(record.rate_limit_tier || record.rateLimitTier || '').toLowerCase()
  const matched = rateTier.match(/(?:^|_)claude_(pro|max|ultra)(?:_|$)/)
  return matched ? normalizeClaudeTier(matched[1]) : null
}

export function inferClaudeTier(vm = {}, quota = {}) {
  if (!(vm.has_token || vm.has_access)) return { key: 'none', label: null }
  const identity = vm.subscription_type || vm.subscriptionType ? vm : quota
  const explicit = claudeSubscriptionTier(identity) || claudeSubscriptionTier(vm)
  if ((identity.subscription_type || identity.subscriptionType) && !explicit) return { key: 'none', label: null }
  const source = vm.account_tier_source || quota.account_tier_source
  const candidate = normalizeClaudeTier(vm.account_tier || quota.account_tier)
  const stored = source === 'default' || (source === 'usage' && candidate === 'max') ? null : candidate
  const key = explicit || stored || 'none'
  return { key, label: key === 'max' ? 'Max' : key === 'pro' ? 'Pro' : null }
}

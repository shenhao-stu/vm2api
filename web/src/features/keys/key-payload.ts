import type { ApiKeyItem } from '@/types/panel-keys'

export type KeyGroupType = 'all' | 'anthropic' | 'openai' | 'pool'

export type KeyLimitsDraft = {
  name: string
  category: 'oauth' | 'api' | 'hybrid'
  openai_endpoint_id?: string
  max_concurrency: number
  quota_requests: number
  quota_usd: number
  rpm: number
  expires_in_days: number
  group_type: KeyGroupType
  allowed_vms: string[]
  vm_pool_id?: string
}

export function keyLimitsDraft(
  initial?: ApiKeyItem | null,
  withPools = false
): KeyLimitsDraft {
  const group =
    withPools && initial?.vm_pool_id
      ? 'pool'
      : groupTypeOf(initial?.group_type || 'all')
  return {
    name: initial?.name || '',
    category: initial?.category || 'oauth',
    openai_endpoint_id: initial?.openai_endpoint_id || '',
    max_concurrency: Number(initial?.max_concurrency ?? 20),
    quota_requests: Number(initial?.quota_requests ?? 0),
    quota_usd: Number(initial?.quota_usd ?? 0),
    rpm: Number(initial?.rpm ?? 0),
    expires_in_days: initial ? 0 : 30,
    group_type: group,
    allowed_vms:
      group === 'all' || group === 'pool' ? [] : initial?.allowed_vms || [],
    ...(withPools ? { vm_pool_id: initial?.vm_pool_id || '' } : {}),
  }
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${label}必须是非负数`)
  return value
}

function groupTypeOf(value: string): KeyGroupType {
  if (value === 'anthropic' || value === 'openai') return value
  return 'all'
}

export function keyLimitsPayload(
  draft: KeyLimitsDraft,
  mode: 'create' | 'edit',
  options: { isAdmin?: boolean } = {}
): Record<string, unknown> {
  const isAdmin = options.isAdmin ?? true
  const hybrid = draft.category === 'hybrid'
  if (hybrid && !isAdmin && mode === 'create') {
    throw new Error('统一密钥由管理员创建')
  }
  if (hybrid && !['anthropic', 'pool'].includes(draft.group_type)) {
    throw new Error('统一密钥必须选择 Claude 槽位或账号池')
  }
  const requests = nonNegative(draft.quota_requests, '请求额度')
  if (!Number.isInteger(requests)) throw new Error('请求额度必须是整数')
  const body: Record<string, unknown> = {
    max_concurrency: nonNegative(draft.max_concurrency, '并发'),
    quota_requests: requests,
    quota_usd: nonNegative(draft.quota_usd, 'USD 额度'),
    rpm: nonNegative(draft.rpm, 'RPM'),
  }
  // API 直连不经过槽位，只有管理员可以设置
  if (isAdmin) {
    body.category = draft.category
    if (hybrid) {
      const endpoint = String(draft.openai_endpoint_id || '').trim()
      if (!/^ep_[a-f0-9]{12}$/.test(endpoint))
        throw new Error('选择一个 GPT 本机网关')
      body.openai_endpoint_id = endpoint
    } else if (mode === 'edit') body.openai_endpoint_id = null
  }
  // Tenant edits retain administrator-owned hybrid routing exactly.
  if (hybrid && !isAdmin && mode === 'edit') return body
  if (isAdmin && draft.group_type === 'pool') {
    const vm_pool_id = String(draft.vm_pool_id || '').trim()
    if (!vm_pool_id) throw new Error('选择一个账号池')
    body.group_type = hybrid ? 'anthropic' : 'all'
    body.allowed_vms = []
    body.vm_pool_id = vm_pool_id
  } else {
    const group_type = groupTypeOf(draft.group_type)
    const allowed_vms =
      group_type === 'all'
        ? []
        : [...new Set(draft.allowed_vms.map((id) => id.trim()).filter(Boolean))]
    if (group_type !== 'all' && allowed_vms.length === 0) {
      throw new Error('至少选择一台 VM')
    }
    body.group_type = group_type
    body.allowed_vms = allowed_vms
    if (isAdmin && draft.vm_pool_id !== undefined) body.vm_pool_id = null
  }
  if (mode === 'create') {
    body.name = draft.name.trim()
    const days = nonNegative(draft.expires_in_days, '有效期')
    if (days > 0) body.expires_in_days = days
  }
  return body
}

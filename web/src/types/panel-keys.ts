import type { VmUsageStatsDay, VmUsageStatsRank } from '@/types/panel-vm'

export type ApiKeyItem = {
  id: string
  name?: string
  /** 旧字段别名。列表请用 `key_prefix` / `maskApiKeyItem()`。 */
  prefix?: string
  key_prefix?: string
  key_suffix?: string
  /**
   * 列表接口返回掩码（含 `…`）。明文只出现在 create / reveal / rotate 的一次性响应里，
   * 不得渲染到列表、title、toast、console。
   */
  key?: string
  revealable?: boolean
  status?: string
  category?: 'oauth' | 'api' | 'hybrid'
  openai_endpoint_id?: string | null
  max_concurrency?: number
  quota_requests?: number
  quota_used?: number
  quota_usd?: number
  quota_usd_used?: number
  rpm?: number
  expires_at?: string | null
  created_at?: string
  updated_at?: string
  last_used_at?: string
  requests?: number
  inflight?: number
  /** all = 全局可调度。原生分组需 allowed_vms；hybrid/openai 仅绑定网关且槽位为空。 */
  group_type?: 'all' | 'anthropic' | 'openai'
  allowed_vms?: string[]
  vm_pool_id?: string | null
  vm_pool_name?: string | null
}

export type VmPool = {
  id: string
  name: string
  enabled: boolean
  vm_ids: string[]
}

export type ApiKeysPayload = {
  keys?: ApiKeyItem[]
}

export type KeyUsageStats = {
  days: number
  since: string | null
  history: VmUsageStatsDay[]
  models: VmUsageStatsRank[]
  vms: VmUsageStatsRank[]
}

export type KeyStatsPayload = {
  item?: ApiKeyItem
  usage_stats?: KeyUsageStats | null
}

export type NativeRelay = {
  id: string
  name: string
  node: string
  binding: number
  sub_account: number
  concurrency: number
  models: string[]
  usage?: {
    total_usd: number
    last_5h_usd: number
    unpriced_requests: number
    first_at: string | null
  } | null
  official_quota?: {
    used_usd: number
    quota_usd: number
    resets_at_ms: number | null
    observed_at_ms: number
    stale: boolean
  } | null
  observed_at: number
  authorization_latched: boolean
  guard: {
    ready: boolean
    latched: boolean
    expected_ip: string
    observed_ip?: string
  }
  runtime: {
    container_running: boolean
    http_active: boolean
    http_ready: boolean
    active_requests: number | null
    revoked: boolean
    auth_latched: boolean
    failed_checks: string[]
  }
  sub: { schedulable: boolean }
}

export function relayState(relay: NativeRelay) {
  if (
    relay.authorization_latched ||
    relay.runtime.revoked ||
    relay.runtime.auth_latched
  )
    return '授权锁存'
  if (!relay.guard.ready) return '出口待检查'
  if (relay.runtime.failed_checks.length) return '原生环境待检查'
  if (!relay.runtime.http_active || !relay.sub.schedulable) return '已暂停'
  return relay.runtime.http_ready ? '运行中' : 'Relay 待检查'
}

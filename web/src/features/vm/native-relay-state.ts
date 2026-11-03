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
    last_7d_usd?: number
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
  management_unavailable?: boolean
  observed_at: number
  authorization_latched: boolean
  guard: {
    ready: boolean
    latched: boolean
    expected_ip: string
    observed_ip?: string
  }
  runtime: {
    official_windows?: {
      five_hour: { used_percent: number; resets_at_ms: number }
      seven_day: { used_percent: number; resets_at_ms: number }
      observed_at_ms: number
      source_updated_ms: number
      stale: boolean
    } | null
    container_running: boolean
    http_active: boolean
    http_ready: boolean
    management_paused?: boolean
    active_requests: number | null
    revoked: boolean
    auth_latched: boolean
    failed_checks: string[]
  }
  sub: {
    schedulable: boolean | null
    shared_policy_matches?: boolean
    rate_limit_reset_at?: string | null
    temp_unschedulable_until?: string | null
  }
}

export function canResumeSchedule(relay: NativeRelay) {
  const runtime = relay.runtime
  return (
    !relay.management_unavailable &&
    !relay.authorization_latched &&
    !runtime.revoked &&
    !runtime.auth_latched &&
    !runtime.management_paused &&
    !runtime.failed_checks.length &&
    runtime.container_running &&
    runtime.http_active &&
    runtime.http_ready &&
    relay.guard.ready &&
    !relay.guard.latched &&
    relay.sub.shared_policy_matches !== false
  )
}

export function scheduleLabel(relay: NativeRelay, now = Date.now()) {
  if (relay.sub.schedulable == null) return '状态未知'
  if (!relay.sub.schedulable) return '已暂停'
  const limits = [
    relay.sub.rate_limit_reset_at,
    relay.sub.temp_unschedulable_until,
  ]
  return limits.some((value) => value && Date.parse(value) > now)
    ? '冷却中'
    : '已开启'
}

export function relayState(relay: NativeRelay, now = Date.now()) {
  if (relay.management_unavailable) return '管理连接待检查'
  if (
    relay.authorization_latched ||
    relay.runtime.revoked ||
    relay.runtime.auth_latched
  )
    return '授权锁存'
  if (relay.sub.shared_policy_matches === false) return '调度配置待核对'
  if (!relay.guard.ready || relay.guard.latched) return '出口待检查'
  if (relay.runtime.failed_checks.length) return '原生环境待检查'
  if (!relay.runtime.container_running) return '原生环境待检查'
  if (relay.sub.schedulable == null) return '调度状态未知'
  if (
    !relay.runtime.http_active ||
    relay.runtime.management_paused ||
    !relay.sub.schedulable
  )
    return '已暂停'
  if (scheduleLabel(relay, now) === '冷却中') return '额度冷却'
  return relay.runtime.http_ready ? '运行中' : 'Relay 待检查'
}

export function scheduleResetAt(
  relay: NativeRelay,
  now: number
): number | null {
  const times = [
    relay.sub.rate_limit_reset_at,
    relay.sub.temp_unschedulable_until,
  ]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter((value) => value > now)
  return times.length ? Math.max(...times) : null
}

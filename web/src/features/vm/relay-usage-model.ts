import type { NativeRelay } from './native-relay-state'

const validAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

// 套餐美元总额没有窗口语义，不能推算成 5H / 7D 或其他账号的额度。
export function relayUsageModel(relay: NativeRelay, now: number) {
  const source = relay.runtime.official_windows
  const q = relay.official_quota
  const windows = (
    [
      ['5H', 'five_hour'],
      ['7D', 'seven_day'],
    ] as const
  ).map(([label, key]) => {
    const row = source?.[key]
    return {
      label,
      pct: validAmount(row?.used_percent) ? row.used_percent : null,
      reset: row?.resets_at_ms ?? null,
    }
  })
  const quota =
    q && validAmount(q.used_usd) && validAmount(q.quota_usd) && q.quota_usd > 0
      ? q
      : null
  const stale = Boolean(
    source?.stale ||
    quota?.stale ||
    windows.some((w) => w.reset != null && w.reset <= now) ||
    (quota?.resets_at_ms != null && quota.resets_at_ms <= now)
  )
  return {
    windows,
    quota,
    stale,
    rows: (
      [
        ['5H', relay.usage?.last_5h_usd],
        ['7D', relay.usage?.last_7d_usd],
        ['总计', relay.usage?.total_usd],
      ] as const
    ).map(([label, value]) => ({
      label,
      value: validAmount(value) ? value : undefined,
    })),
  }
}

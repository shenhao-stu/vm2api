import type { NativeRelay } from './native-relay-state'

const validAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

// 套餐美元总额没有窗口语义，不能推算成 5H / 7D 或其他账号的额度。
export function relayUsageModel(relay: NativeRelay, now: number) {
  const source = relay.runtime.official_windows
  const q = relay.official_quota
  const sourceStale = Boolean(
    source &&
    (source.stale ||
      now - source.observed_at_ms > 900_000 ||
      now - source.source_updated_ms > 7_200_000)
  )
  const windows = (
    [
      ['5H', 'five_hour'],
      ['7D', 'seven_day'],
    ] as const
  ).map(([label, key]) => {
    const row = source?.[key]
    const expired = row?.resets_at_ms != null && row.resets_at_ms <= now
    const stale = sourceStale || expired
    return {
      label,
      pct: !stale && validAmount(row?.used_percent) ? row.used_percent : null,
      reset: expired ? null : (row?.resets_at_ms ?? null),
      note:
        row && stale
          ? expired
            ? '已过重置 · 待更新'
            : '读数过期 · 待更新'
          : null,
    }
  })
  const quota =
    q && validAmount(q.used_usd) && validAmount(q.quota_usd) && q.quota_usd > 0
      ? q
      : null
  const windowsStale = windows.some((w) => w.note != null)
  const quotaStale = Boolean(
    quota &&
    (quota.stale ||
      now - quota.observed_at_ms > 900_000 ||
      (quota.resets_at_ms != null && quota.resets_at_ms <= now))
  )
  return {
    windows,
    quota,
    windowsStale,
    quotaStale,
    stale: windowsStale || quotaStale,
    rows: (
      [
        ['近5H', relay.usage?.last_5h_usd],
        ['近7D', relay.usage?.last_7d_usd],
        ['总计', relay.usage?.total_usd],
      ] as const
    ).map(([label, value]) => ({
      label,
      value: validAmount(value) ? value : undefined,
    })),
  }
}

import type { NativeRelay } from './native-relay-state'

const short = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})
const percent = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })
const time = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const exactTime = (ms: number) =>
  new Date(ms).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  })

function money(n: number | undefined) {
  if (n === undefined) return '—'
  return n > 0 && n < 0.01 ? '<$0.01' : short.format(n)
}

export function RelayUsageCard({ relay }: { relay: NativeRelay }) {
  const windows = relay.runtime.official_windows
  const q = relay.official_quota
  const usage = relay.usage
  const pct = q ? (100 * q.used_usd) / q.quota_usd : 0
  const fill = Math.min(100, pct)
  const rows = [
    ['5H', usage?.last_5h_usd],
    ['7D', usage?.last_7d_usd],
    ['总计', usage?.total_usd],
  ] as const
  return (
    <>
      <section
        aria-label='ReClaude 官方套餐窗口'
        className='space-y-1.5 text-sm'
      >
        {windows ? (
          <>
            <h4 className='text-xs text-muted-foreground'>套餐已用</h4>
            {(
              [
                ['5H', windows.five_hour],
                ['7D', windows.seven_day],
              ] as const
            ).map(([label, row]) => (
              <div key={label} className='flex items-center gap-2 text-xs'>
                <span>{label}</span>
                <progress
                  aria-label={label + ' 套餐已用'}
                  className='h-1.5 flex-1 accent-emerald-500'
                  max={100}
                  value={Math.min(row.used_percent, 100)}
                />
                <b>{percent.format(row.used_percent)}%</b>
                <span
                  className='text-muted-foreground'
                  title={exactTime(row.resets_at_ms)}
                >
                  {time.format(row.resets_at_ms)} 重置
                </span>
              </div>
            ))}
            {windows.stale && (
              <span className='text-xs text-muted-foreground'>上次记录</span>
            )}
          </>
        ) : (
          <>
            <div className='flex items-baseline justify-between gap-2'>
              <span className='text-muted-foreground'>套餐已用 / 总额</span>
              <b
                className='font-mono tabular-nums'
                title={q ? `${q.used_usd} / ${q.quota_usd} USD` : undefined}
              >
                {q ? `${money(q.used_usd)} / ${money(q.quota_usd)}` : '—'}
              </b>
            </div>
            {q ? (
              <>
                <div className='flex items-center gap-3'>
                  <div
                    role='meter'
                    aria-label='官方套餐已用比例'
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={fill}
                    aria-valuetext={`已用 ${percent.format(pct)}%`}
                    className='h-1.5 flex-1 overflow-hidden rounded-full bg-muted'
                  >
                    <div
                      className={`h-full rounded-full ${q.stale ? 'bg-muted-foreground' : pct >= 100 ? 'bg-destructive' : 'bg-emerald-500'}`}
                      style={{ width: `${fill}%` }}
                    />
                  </div>
                  <span className='font-mono text-xs font-semibold'>
                    {percent.format(pct)}%
                  </span>
                </div>
                <div className='flex justify-between text-xs text-muted-foreground'>
                  <span title={q.resets_at_ms ? exactTime(q.resets_at_ms) : ''}>
                    重置{' '}
                    {q.resets_at_ms
                      ? time.format(q.resets_at_ms) + ' 北京时间'
                      : '待定'}
                  </span>
                  {q.stale && <span>已过期</span>}
                </div>
              </>
            ) : (
              <p className='text-xs text-muted-foreground'>等待官方额度</p>
            )}
          </>
        )}
      </section>
      <section aria-label='本 Relay 已记用量' className='border-t pt-2 text-sm'>
        <h4 className='mb-1 text-xs text-muted-foreground'>vm2api 用量</h4>
        <dl className='space-y-1'>
          {rows.map(([label, value]) => (
            <div
              key={label}
              className={`flex justify-between ${label === '总计' ? 'border-t pt-1 font-semibold' : ''}`}
            >
              <dt>{label}</dt>
              <dd
                title={value === undefined ? undefined : `${value} USD`}
                className='font-mono tabular-nums'
              >
                {money(value)}
              </dd>
            </div>
          ))}
        </dl>
        {!!usage?.unpriced_requests && (
          <small className='text-muted-foreground'>
            {usage.unpriced_requests} 条缺少计价
          </small>
        )}
      </section>
    </>
  )
}

export function RelayUsageDetail({ relay }: { relay: NativeRelay }) {
  const q = relay.official_quota
  return q ? (
    <p className='text-xs text-muted-foreground'>
      官方已用 {q.used_usd} / {q.quota_usd} USD
      <br />
      {q.resets_at_ms && <>重置 {exactTime(q.resets_at_ms)} · </>}同步{' '}
      {exactTime(q.observed_at_ms)}（北京）
    </p>
  ) : null
}

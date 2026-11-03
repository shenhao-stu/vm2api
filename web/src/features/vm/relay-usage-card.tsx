import { cn } from '@/lib/utils'
import type { NativeRelay } from './native-relay-state'
import { QuotaWindowRow } from './quota-window-row'
import { relayUsageModel } from './relay-usage-model'

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})
const exactTime = (ms: number) =>
  new Date(ms).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  })
const money = (value: number | undefined) =>
  value === undefined
    ? '—'
    : value > 0 && value < 0.01
      ? '<$0.01'
      : currency.format(value)

export function RelayUsageCard({
  relay,
  now,
}: {
  relay: NativeRelay
  now: number
}) {
  const { windows, quota, stale, rows } = relayUsageModel(relay, now)
  return (
    <>
      <section aria-label='ReClaude 官方套餐窗口' className='grid gap-1'>
        <h4 className='flex h-5 justify-between text-xs text-muted-foreground'>
          <span>官方额度</span>
          {stale && (
            <span title='保留上次读数，重置后等待官方更新'>待更新</span>
          )}
        </h4>
        {windows.map((w) => (
          <QuotaWindowRow key={w.label} w={w} now={now} hasToken quiet />
        ))}
        <div
          className='flex h-5 items-center justify-between gap-2 text-xs'
          title='官方套餐美元额度；与 5H / 7D 百分比及本 Relay 用量独立'
        >
          <span className='text-muted-foreground'>套餐</span>
          <span
            className='font-mono tabular-nums'
            title={quota ? undefined : '官方未提供美元总额'}
          >
            {quota
              ? `${money(quota.used_usd)} / ${money(quota.quota_usd)}`
              : '—'}
          </span>
        </div>
      </section>
      <section aria-label='本 Relay 已记用量' className='hairline-t pt-2'>
        <h4 className='mb-1 text-xs text-muted-foreground'>vm2api 用量</h4>
        <dl className='grid gap-1'>
          {rows.map(({ label, value }) => (
            <div
              key={label}
              className={cn(
                'flex h-5 items-center justify-between text-xs',
                label === '总计' && 'hairline-t font-semibold'
              )}
            >
              <dt className={label === '总计' ? '' : 'text-muted-foreground'}>
                {label}
              </dt>
              <dd
                title={value === undefined ? undefined : `${value} USD`}
                className='font-mono tabular-nums'
              >
                {money(value)}
              </dd>
            </div>
          ))}
        </dl>
        {!!relay.usage?.unpriced_requests && (
          <small className='text-muted-foreground'>
            {relay.usage.unpriced_requests} 条缺少计价
          </small>
        )}
      </section>
    </>
  )
}

export function RelayUsageDetail({ relay }: { relay: NativeRelay }) {
  const q = relay.official_quota
  const windows = relay.runtime.official_windows
  return (
    <div className='space-y-1 text-xs text-muted-foreground'>
      {!windows && <p>官方未提供 5H / 7D 百分比，显示为 —。</p>}
      {windows && <p>窗口同步 {exactTime(windows.observed_at_ms)}（北京）</p>}
      {q && (
        <p>
          套餐已用 {money(q.used_usd)} / {money(q.quota_usd)}，
          {q.resets_at_ms ? `重置 ${exactTime(q.resets_at_ms)}` : '重置待定'}
          。同步 {exactTime(q.observed_at_ms)}（北京）
        </p>
      )}
      <p>官方额度可能包含同组织其他设备；下方用量仅属于本 Relay。</p>
    </div>
  )
}

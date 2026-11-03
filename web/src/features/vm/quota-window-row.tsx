import {
  expiresAtToMs,
  fmtResetClock,
  resetCountdown,
} from '@/lib/fable-status'
import { cn } from '@/lib/utils'
import { riskFg, UsageMeter } from './usage-meter'

const METRIC_ROW = 'h-5'
const MUTED_NUM = 'text-[color:var(--text-tertiary)]'

const WINDOW_GRID =
  'grid grid-cols-[2.25rem_minmax(2.5rem,1fr)_2.25rem_3.25rem] items-center gap-x-1'

export function QuotaWindowRow({
  w,
  now,
  hasToken,
  quiet,
}: {
  w: { label: string; pct: number | null; reset: unknown; note?: string | null }
  now: number
  hasToken: boolean
  quiet: boolean
}) {
  // 无凭证槽没有窗口，倒计时无意义；有票才算。
  const reset = hasToken ? resetCountdown(w.reset, now) : null
  const clock =
    hasToken && expiresAtToMs(w.reset)
      ? `重置于 ${fmtResetClock(w.reset)}`
      : undefined
  const pct = w.pct
  return (
    <div className={cn(WINDOW_GRID, METRIC_ROW)}>
      <span className='text-xs font-medium text-muted-foreground'>
        {w.label}
      </span>
      {w.note ? (
        <span
          className='col-span-2 truncate text-xs font-medium text-[color:var(--status-warn)]'
          title={w.note}
        >
          {w.note}
        </span>
      ) : (
        <>
          {pct == null ? (
            <div
              className='h-[5px] w-full rounded-full track-recessed'
              aria-hidden='true'
            />
          ) : (
            <UsageMeter
              value={pct}
              size='sm'
              ticks={false}
              label={`${w.label} 已用`}
            />
          )}
          <span
            className={cn(
              'text-right font-mono text-xs font-medium tabular-nums',
              pct == null
                ? MUTED_NUM
                : // 分诊面上绿色数字铺满一屏是噪声，颜色只留给越过 70% 的档。
                  (!quiet || pct >= 70) && riskFg(pct)
            )}
            title={pct == null ? '未探测' : undefined}
          >
            {pct == null ? '—' : `${pct.toFixed(0)}%`}
          </span>
        </>
      )}
      <span
        className='truncate text-right font-mono text-[11px] text-muted-foreground tabular-nums'
        title={clock}
      >
        {reset ?? ''}
      </span>
    </div>
  )
}

import type { Vm } from '@/types/panel-vm'
import { fmtAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'

const creditNumber = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 2,
})

export function codexCreditReadout(credits: Vm['codex_credits'], now: number) {
  const raw = credits?.balance
  const amount =
    typeof raw === 'number' ||
    (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw))
      ? Number(raw)
      : NaN
  const balance = Number.isFinite(amount) && amount >= 0 ? amount : null
  const value =
    credits?.unlimited === true
      ? '不限量'
      : balance == null
        ? '—'
        : balance > 0 && balance < 0.01
          ? '<0.01'
          : creditNumber.format(balance)
  const fetched = Date.parse(credits?.fetched_at || '')
  const age = now - fetched
  // Match the native credit snapshot's 10-minute freshness contract.
  const fresh = Number.isFinite(age) && age >= 0 && age <= 10 * 60_000
  const status = !credits
    ? '未查询'
    : !fresh
      ? '待更新'
      : value === '—'
        ? '未提供余额'
        : `${fmtAgo(credits?.fetched_at, now)}更新`
  const detail = [
    '官方积分，不是美元或重置券',
    balance != null && `精确余额：${raw}`,
    Number.isFinite(fetched) &&
      `更新：${new Date(fetched).toLocaleString('zh-CN')}`,
    !fresh && '旧值仅供参考，不能代表当前可用积分',
  ]
    .filter(Boolean)
    .join('；')
  return { value, status, detail, fresh }
}

export function CodexCreditBalance({
  vm,
  now,
  className,
}: {
  vm: Vm
  now: number
  className?: string
}) {
  if (!isCodexVm(vm)) return null
  const view = codexCreditReadout(vm.codex_credits, now)
  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs',
        className
      )}
      title={view.detail}
    >
      <span className='text-muted-foreground'>剩余积分</span>
      <span
        className={cn(
          'ms-auto font-mono font-semibold tabular-nums',
          !view.fresh && 'text-muted-foreground'
        )}
      >
        {view.value}
      </span>
      <span className='text-[11px] text-muted-foreground'>{view.status}</span>
    </div>
  )
}

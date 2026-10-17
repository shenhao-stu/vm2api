import { useState } from 'react'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useOnboardingAction } from './queries'
import type { UsageProfile } from './types'

const OPTIONS: { id: UsageProfile; title: string; body: string }[] = [
  {
    id: 'personal',
    title: '个人自用',
    body: '关闭 5 小时和 7 天闸。三档闸线拉到 100%，执行并发拉到 256，每分钟请求数保持不限。蒸馏、硬正则和拒答缓存关掉；决策模型保持关，阈值降到 0。',
  },
  {
    id: 'relay',
    title: '中转站',
    body: '5 小时和 7 天闸开着。default / Pro 并发 2，Max 并发 4；闸线 85% / 80%，Max 是 95%。蒸馏、硬正则和拒答缓存开着，决策模型关着。',
  },
]

export function WelcomeUsageMode({
  profile,
}: {
  profile: UsageProfile | null
}) {
  const action = useOnboardingAction()
  const [error, setError] = useState<string | null>(null)

  function choose(next: string) {
    if (next !== 'personal' && next !== 'relay') return
    if (next === profile || action.isPending) return
    setError(null)
    action.mutate(
      { action: 'profile', mode: next },
      {
        onError: (err) => {
          const message = err instanceof Error ? err.message : '保存失败'
          setError(`${message} 这次没有保存，仍是之前的选择。`)
        },
      }
    )
  }

  return (
    <section
      className='relative z-10 px-6 pb-4'
      aria-labelledby='welcome-usage'
    >
      <div className='mx-auto flex max-w-6xl flex-col gap-4 rounded-2xl border bg-card p-4 shadow-xs sm:p-6'>
        <div className='flex max-w-2xl flex-col gap-1'>
          <h2
            id='welcome-usage'
            className='text-xl font-semibold tracking-tight sm:text-2xl'
          >
            先选这台网关怎么用
          </h2>
          <p className='text-sm leading-relaxed text-muted-foreground'>
            只改虚拟机限额和风控。提示词、探测和健康缓存沿用现在的默认，其它设置不动。
          </p>
        </div>
        <RadioGroup
          value={profile ?? ''}
          onValueChange={choose}
          disabled={action.isPending}
          aria-label='用法'
          aria-describedby={error ? 'welcome-usage-error' : undefined}
          aria-invalid={error ? true : undefined}
          className='gap-0 overflow-hidden rounded-2xl border bg-background/70'
        >
          {OPTIONS.map((option) => (
            <div
              key={option.id}
              className='flex items-start gap-3 border-b px-3 py-3 last:border-b-0'
              data-checked={profile === option.id ? 'true' : undefined}
            >
              <RadioGroupItem
                id={`usage-${option.id}`}
                value={option.id}
                className='mt-1'
              />
              <label
                htmlFor={`usage-${option.id}`}
                className='flex min-w-0 flex-col gap-1'
              >
                <span className='text-sm font-medium'>{option.title}</span>
                <span className='text-xs leading-relaxed text-muted-foreground'>
                  {option.body}
                </span>
              </label>
            </div>
          ))}
        </RadioGroup>
        {error ? (
          <p
            id='welcome-usage-error'
            className='text-sm text-destructive'
            role='alert'
          >
            {error}
          </p>
        ) : null}
      </div>
    </section>
  )
}

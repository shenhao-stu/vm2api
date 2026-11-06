import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { SettingRow } from '@/components/setting-row'
import { PaneSection } from './scheduler-controls'

type Config = {
  enabled: boolean
  interval_minutes: number
  model: string
  failure_threshold: number
  concurrency: number
  prompt: string
  expected_answer: string
}
type Item = {
  vm_id: string
  vm_name: string | null
  paused: boolean
  consecutive_wrong: number
  last_result: string | null
  last_error: string | null
  upstream_model: string | null
  safety_buffering: boolean | null
  recovery_phase: string | null
  recovery_next_at: string | null
}
export type QualityProbeView = {
  config: Config
  progress: { running: boolean; completed: number; total: number }
  items: Item[]
}

const queryKey = ['panel', 'quality-probe'] as const
const endpoint = '/api/panel/quality-probe'
const results: Record<string, string> = {
  correct: '答对',
  wrong: '答错',
  error: '请求错误',
  invalid: '无效答案',
  skipped: '已跳过',
}

export function QualityProbeResults({ items }: { items: Item[] }) {
  return (
    <div className='space-y-2' aria-label='GPT 质量检测结果'>
      {items.length === 0 && (
        <p className='text-sm text-muted-foreground'>暂无 GPT 账号</p>
      )}
      {items.map((item) => (
        <div key={item.vm_id} className='rounded-md border p-3 text-sm'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='font-medium'>{item.vm_name || item.vm_id}</span>
            <Badge variant={item.paused ? 'destructive' : 'secondary'}>
              {item.paused
                ? '质量暂停'
                : results[item.last_result || ''] || '尚未检测'}
            </Badge>
            <span className='text-muted-foreground'>
              连续答错 {item.consecutive_wrong} 次
            </span>
          </div>
          {item.last_error && (
            <p className='mt-1 text-muted-foreground'>{item.last_error}</p>
          )}
          <p className='mt-1 text-xs text-muted-foreground'>
            上游模型：{item.upstream_model || '未报告'}；安全缓冲：
            {item.safety_buffering === true
              ? '已观察到'
              : item.safety_buffering === false
                ? '未触发'
                : '未知'}
          </p>
          {item.recovery_next_at && (
            <p className='mt-1 text-xs text-muted-foreground'>
              {item.recovery_phase === 'confirming' ? '二次确认' : '静置后复测'}
              ：{new Date(item.recovery_next_at).toLocaleString()}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

export function QualityProbePane() {
  const qc = useQueryClient()
  const status = useQuery({
    queryKey,
    queryFn: () => api<QualityProbeView>(endpoint),
    refetchInterval: (query) =>
      query.state.data?.progress.running ? 2000 : false,
  })
  const [draft, setDraft] = useState<Config | null>(null)
  const save = useMutation({
    mutationFn: (config: Config) =>
      api<QualityProbeView>(endpoint, {
        method: 'PUT',
        body: JSON.stringify(config),
      }),
    onSuccess: (data) => {
      qc.setQueryData(queryKey, data)
      setDraft(null)
      toast.success('已保存质量检测配置')
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const run = useMutation({
    mutationFn: () =>
      api<QualityProbeView>(`${endpoint}/run`, { method: 'POST', body: '{}' }),
    onSuccess: (data) => qc.setQueryData(queryKey, data),
    onError: (error: Error) => toast.error(error.message),
  })
  const config = draft || status.data?.config
  const update = (patch: Partial<Config>) =>
    config && setDraft({ ...config, ...patch })
  return (
    <PaneSection
      icon={Activity}
      title='GPT 质量检测与静置恢复'
      desc='答题结果与上游安全缓冲信号仅用于质量筛查，不能证明模型身份。检测会消耗额度，默认关闭。连续答错触发暂停；静置 24 小时后复测，答对后隔 10 分钟再次确认才恢复。人工、认证、额度和工作时段限制继续有效。'
    >
      {status.error && <p role='alert'>{status.error.message}</p>}
      {!config && !status.error && <p>加载中…</p>}
      {config && (
        <>
          <SettingRow
            label='启用质量检测'
            desc='仅 GPT 账号；关闭时停止后续检测及自动恢复，保留暂停状态。'
          >
            <Switch
              checked={config.enabled}
              onCheckedChange={(enabled) => update({ enabled })}
              aria-label='启用 GPT 质量检测'
            />
          </SettingRow>
          <div className='grid gap-3 sm:grid-cols-2'>
            {(
              [
                ['model', 'GPT 模型'],
                ['interval_minutes', '检测间隔（分钟）'],
                ['failure_threshold', '连续答错阈值'],
                ['concurrency', '探测并发'],
                ['expected_answer', '期望答案'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className='space-y-1 text-sm'>
                <span>{label}</span>
                <Input
                  aria-label={label}
                  value={config[key]}
                  type={typeof config[key] === 'number' ? 'number' : 'text'}
                  onChange={(event) =>
                    update({
                      [key]:
                        typeof config[key] === 'number'
                          ? Number(event.target.value)
                          : event.target.value,
                    })
                  }
                />
              </label>
            ))}
          </div>
          <label className='block space-y-1 text-sm'>
            <span>检测题目</span>
            <Textarea
              aria-label='检测题目'
              value={config.prompt}
              onChange={(event) => update({ prompt: event.target.value })}
            />
          </label>
          <div className='flex flex-wrap items-center gap-3'>
            <Button
              disabled={!draft || save.isPending}
              onClick={() => draft && save.mutate(draft)}
            >
              保存检测配置
            </Button>
            <Button
              variant='outline'
              disabled={
                !status.data?.config.enabled ||
                !!draft ||
                run.isPending ||
                status.data?.progress.running
              }
              onClick={() => run.mutate()}
            >
              立即检测
            </Button>
            {status.data?.progress.running && (
              <span className='text-sm'>
                已完成 {status.data.progress.completed}/
                {status.data.progress.total}
              </span>
            )}
          </div>
          <QualityProbeResults items={status.data?.items || []} />
        </>
      )}
    </PaneSection>
  )
}

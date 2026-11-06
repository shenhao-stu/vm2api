import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'

type Mode = 'manual' | 'daily' | 'hourly'
type Probe = {
  mode: Mode
  model: string
  config?: {
    failure_threshold: number
    interval_minutes: number
    concurrency: number
  }
  running: boolean
  items: {
    vm_id: string
    paused: boolean
    wrong: number
    result?: string
    due?: number
    first_pass?: number | null
    last_at?: number
  }[]
}
const endpoint = '/api/panel/quality-probe'
const key = ['codex-quality'] as const
const labels: Record<string, string> = {
  correct: '答对',
  wrong: '答错',
  invalid: '格式不符',
  unverified: '终态未验证',
  exit_unverified: '固定出口未验证',
  model_mismatch: '返回模型不同',
  skipped: '暂不具备探测条件',
  transport_error: '连接失败',
  error: '探测失败',
  pending: '待核验',
}
const time = (ms: number) =>
  new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

export function CodexQualityCard() {
  const client = useQueryClient()
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<Probe>(endpoint),
    refetchInterval: (query) => (query.state.data?.running ? 2000 : 60_000),
  })
  const action = useMutation({
    mutationFn: (mode: Mode | 'run') =>
      mode === 'run'
        ? api<Probe>(endpoint + '/run', { method: 'POST' })
        : api<Probe>(endpoint, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode }),
          }),
    onSuccess: (data) => {
      client.setQueryData(key, data)
      void client.invalidateQueries({ queryKey: ['panel', 'quality-probe'] })
    },
  })
  const data = q.data
  return (
    <details className='mb-3 rounded-lg border bg-card p-3 text-sm'>
      <summary className='cursor-pointer font-medium'>
        GPT 答题质量{data?.running ? ' · 探测中' : ''}
      </summary>
      {data && (
        <div className='mt-3 space-y-3'>
          <div className='flex flex-wrap items-center gap-3'>
            <label>
              探测频率{' '}
              <select
                className='rounded border bg-background p-1'
                value={data.mode}
                disabled={action.isPending || data.running}
                onChange={(e) => action.mutate(e.target.value as Mode)}
              >
                {data.config &&
                  ![60, 1440].includes(data.config.interval_minutes) && (
                    <option value='custom'>
                      {data.config.interval_minutes} 分钟
                    </option>
                  )}
                <option value='manual'>仅手动</option>
                <option value='daily'>每天</option>
                <option value='hourly'>每小时</option>
              </select>
            </label>
            <Button
              size='sm'
              variant='outline'
              disabled={data.running || action.isPending}
              onClick={() => action.mutate('run')}
            >
              测一轮（使用额度）
            </Button>
          </div>
          <p className='text-xs text-muted-foreground'>
            {data.model} · 仅测空闲账号，连续{' '}
            {data.config?.failure_threshold ?? 2} 次答错静置 24 小时，间隔 10
            分钟两次答对后恢复。
          </p>
          {data.items.map((s) => (
            <div
              key={s.vm_id}
              className='flex flex-wrap items-center justify-between gap-2 border-t pt-2'
            >
              <span className='font-mono'>{s.vm_id}</span>
              <span>
                {s.result ? labels[s.result] || s.result : '尚未探测'}
                {s.last_at ? ' · ' + time(s.last_at) : ''}
                {s.paused
                  ? ' · ' +
                    (s.first_pass ? '待二次确认' : '静置') +
                    (s.due ? '至 ' + time(s.due) : '')
                  : s.wrong
                    ? ' · 已错 ' + s.wrong + ' 次'
                    : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      {(q.error || action.error) && (
        <p role='alert' className='mt-2 text-destructive'>
          {(action.error || q.error)?.message}
        </p>
      )}
    </details>
  )
}

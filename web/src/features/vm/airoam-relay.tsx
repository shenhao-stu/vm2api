import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { StatusMark } from '@/components/status-mark'

type RelayStatus = {
  state: 'ready' | 'paused' | 'unavailable' | 'unknown'
  models: string[]
  active_requests?: number
  execution_slots?: number
  resident_sessions?: number
  resident_capacity?: number
}

const labels = {
  ready: '运行中',
  paused: '已暂停',
  unavailable: '不可用',
  unknown: '状态未知',
}
const tones = {
  ready: 'ok',
  paused: 'off',
  unavailable: 'bad',
  unknown: 'none',
}

export function AiroamRelayCard({ status }: { status?: RelayStatus }) {
  const state = status?.state ?? 'unknown'
  return (
    <article
      aria-label='Airoam · AgentNAS Native Relay'
      className='min-w-0 space-y-3 rounded-[10px] bg-muted/50 p-3 ps-3.5 shadow-[inset_0_0_0_1px_var(--hairline)]'
    >
      <header className='flex items-center justify-between gap-3'>
        <h2 className='text-[13px] font-semibold'>
          Airoam · AgentNAS Native Relay
        </h2>
        <StatusMark
          variant='pill'
          tone={{ key: state, cls: tones[state], text: labels[state] }}
        />
      </header>
      <p className='text-xs break-words text-muted-foreground'>
        {status?.models.length ? status.models.join(' · ') : '模型状态未知'}
      </p>
      <dl className='hairline-t grid grid-cols-2 gap-3 pt-2 text-xs'>
        <div>
          <dt className='text-muted-foreground'>执行槽位</dt>
          <dd className='font-mono tabular-nums'>
            {status?.active_requests ?? '—'}/{status?.execution_slots ?? '—'}
          </dd>
        </div>
        <div>
          <dt className='text-muted-foreground'>常驻会话</dt>
          <dd className='font-mono tabular-nums'>
            {status?.resident_sessions ?? '—'}/
            {status?.resident_capacity ?? '—'}
          </dd>
        </div>
      </dl>
    </article>
  )
}

export function AiroamRelay({ enabled }: { enabled: boolean }) {
  const query = useQuery({
    queryKey: ['panel', 'airoam-relay'],
    queryFn: () => api<RelayStatus>('/api/panel/airoam-relay'),
    enabled,
    retry: false,
    refetchInterval: 30_000,
  })
  if (!enabled) return null
  // 与上方原生 Relay 网格同一套列宽，卡片左右边缘对齐。
  return (
    <div className='mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3'>
      <AiroamRelayCard status={query.error ? undefined : query.data} />
    </div>
  )
}

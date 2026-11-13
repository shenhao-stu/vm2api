import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

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

export function AiroamRelayCard({ status }: { status?: RelayStatus }) {
  return (
    <article
      aria-label='Airoam · AgentNAS Native Relay'
      className='mb-5 max-w-xl space-y-3 rounded-[10px] bg-muted/50 p-3.5 shadow-[inset_0_0_0_1px_var(--hairline)]'
    >
      <header className='flex items-center justify-between gap-3'>
        <h2 className='text-[13px] font-semibold'>
          Airoam · AgentNAS Native Relay
        </h2>
        <span className='shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs'>
          {labels[status?.state ?? 'unknown']}
        </span>
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
  return <AiroamRelayCard status={query.error ? undefined : query.data} />
}

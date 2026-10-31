import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, isApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { relayState, type NativeRelay } from './native-relay-state'

const key = ['panel', 'native-relays'] as const
const endpoint = '/api/panel/native-relays'

export function NativeRelays({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient()
  const [action, setAction] = useState<{
    relay: NativeRelay
    verb: 'start' | 'stop'
  } | null>(null)
  const [logTarget, setLogTarget] = useState<NativeRelay | null>(null)
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      try {
        return await api<{ items: NativeRelay[] }>(endpoint)
      } catch (error) {
        if (isApiError(error) && error.status === 404) return { items: [] }
        throw error
      }
    },
    enabled,
    retry: false,
    refetchInterval: 30000,
  })
  const logs = useQuery({
    queryKey: [...key, logTarget?.id, 'logs'],
    queryFn: () =>
      api<{ runtime: unknown[]; management: unknown[] }>(
        `${endpoint}/${encodeURIComponent(logTarget!.id)}/logs`
      ),
    enabled: enabled && !!logTarget,
    retry: false,
  })
  const change = useMutation({
    mutationFn: ({
      relay,
      verb,
    }: {
      relay: NativeRelay
      verb: 'start' | 'stop'
    }) =>
      api(`${endpoint}/${encodeURIComponent(relay.id)}/${verb}`, {
        method: 'POST',
        body: JSON.stringify({ operation_id: crypto.randomUUID() }),
      }),
    retry: false,
    onSuccess: (_data, { verb }) => {
      toast.success(
        verb === 'start' ? 'Relay 已启动并恢复调度' : 'Relay 已停止，调度已暂停'
      )
      setAction(null)
    },
    onError: (error: Error) =>
      toast.error(`操作未完成：${error.message}。请刷新状态后核对。`),
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  })
  if (!enabled) return null
  if (query.error)
    return (
      <section className='mb-4 rounded-lg border p-4' aria-label='原生 Relay'>
        <p>原生 Relay 状态暂不可用：{query.error.message}</p>
        <Button variant='outline' onClick={() => void query.refetch()}>
          重新读取
        </Button>
      </section>
    )
  if (!query.data?.items.length) return null
  return (
    <section className='mb-5 space-y-3' aria-label='原生 Relay'>
      <div className='flex items-center justify-between'>
        <h2 className='font-semibold'>原生 Relay</h2>
        <Button
          variant='outline'
          size='sm'
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          刷新状态
        </Button>
      </div>
      {query.data.items.map((relay) => (
        <article key={relay.id} className='space-y-3 rounded-lg border p-4'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <div>
              <h3 className='font-medium'>{relay.name}</h3>
              <p className='text-sm text-muted-foreground'>
                {relay.node} · 原生 ReClaude · {relayState(relay)}
              </p>
            </div>
            <div className='flex gap-2'>
              <Button
                size='sm'
                variant='outline'
                onClick={() => setLogTarget(relay)}
              >
                查看日志
              </Button>
              <Button
                size='sm'
                variant='outline'
                disabled={
                  change.isPending ||
                  relay.authorization_latched ||
                  !relay.guard.ready ||
                  relay.runtime.revoked ||
                  relay.runtime.auth_latched ||
                  !!relay.runtime.failed_checks.length
                }
                onClick={() => setAction({ relay, verb: 'start' })}
              >
                启动 Relay
              </Button>
              <Button
                size='sm'
                variant='outline'
                disabled={
                  change.isPending ||
                  (!relay.runtime.http_active && !relay.sub.schedulable)
                }
                onClick={() => setAction({ relay, verb: 'stop' })}
              >
                停止 Relay
              </Button>
            </div>
          </div>
          <dl className='grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4'>
            <div>
              <dt className='text-muted-foreground'>固定出口</dt>
              <dd>
                {relay.guard.expected_ip} ·{' '}
                {relay.guard.ready ? '已核验' : '未就绪'}
              </dd>
            </div>
            <div>
              <dt className='text-muted-foreground'>并发 / 在途</dt>
              <dd>
                {relay.concurrency} / {relay.runtime.active_requests ?? '未知'}
              </dd>
            </div>
            <div>
              <dt className='text-muted-foreground'>共享池调度</dt>
              <dd>
                Sub{relay.sub_account} ·{' '}
                {relay.sub.schedulable ? '开启' : '暂停'}
              </dd>
            </div>
            <div>
              <dt className='text-muted-foreground'>设备 / 容器</dt>
              <dd>
                {relay.binding} ·{' '}
                {relay.runtime.container_running ? '运行' : '停止'}
              </dd>
            </div>
          </dl>
          <p className='text-sm break-words'>{relay.models.join(' · ')}</p>
          <p className='text-xs text-muted-foreground'>
            启停仅控制此 Relay
            的接单与工作进程，保留原生授权进程；不重新绑定或解除出口锁存。最近读取：
            {new Date(relay.observed_at * 1000).toLocaleString()}
          </p>
        </article>
      ))}
      <ConfirmDialog
        open={!!action}
        onOpenChange={(open) => {
          if (!open && !change.isPending) setAction(null)
        }}
        title={action?.verb === 'start' ? '启动此 Relay？' : '停止此 Relay？'}
        desc={
          action?.verb === 'start'
            ? '核验原授权及固定出口后启动，并恢复对应 Sub2API 账号调度。锁存需人工排查，此操作不会解锁。'
            : '先暂停对应 Sub2API 账号调度，等待在途请求结束，再停止 Relay 工作进程。原生授权和其他槽位保持运行。'
        }
        handleConfirm={() => {
          if (action) change.mutate(action)
        }}
        isLoading={change.isPending}
      />
      <Dialog
        open={!!logTarget}
        onOpenChange={(open) => {
          if (!open) setLogTarget(null)
        }}
      >
        <DialogContent className='max-h-[85vh] overflow-auto sm:max-w-3xl'>
          <DialogHeader>
            <DialogTitle>{logTarget?.name} · 诊断日志</DialogTitle>
          </DialogHeader>
          <p className='text-sm text-muted-foreground'>
            最近 50 条请求摘要与管理事件，不包含提示词或凭据。
          </p>
          {logs.isLoading ? (
            <p>读取中…</p>
          ) : logs.error ? (
            <p>{logs.error.message}</p>
          ) : (
            <pre className='overflow-auto text-xs break-all whitespace-pre-wrap'>
              {JSON.stringify(logs.data, null, 2)}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}

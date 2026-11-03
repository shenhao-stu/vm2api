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
import { RelayUsageCard, RelayUsageDetail } from './relay-usage-card'

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
    refetchIntervalInBackground: true,
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
      <div className='grid gap-3 md:grid-cols-2 xl:grid-cols-3'>
        {query.data.items.map((relay) => (
          <article
            key={relay.id}
            className='min-w-0 space-y-3 rounded-xl border bg-card p-4 text-card-foreground'
          >
            <header>
              <div className='flex items-center justify-between gap-2'>
                <h3 className='truncate font-semibold' title={relay.name}>
                  {relay.name}
                </h3>
                <span className='shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs'>
                  {relayState(relay)}
                </span>
              </div>
              <p className='mt-1 text-xs text-muted-foreground'>
                {relay.guard.expected_ip} · 席位{' '}
                {relay.runtime.active_requests ?? '—'}/{relay.concurrency}
              </p>
            </header>
            <RelayUsageCard relay={relay} />
            <details className='border-t pt-2 text-sm'>
              <summary className='cursor-pointer text-muted-foreground'>
                详情与控制
              </summary>
              <div className='mt-2 space-y-2'>
                <RelayUsageDetail relay={relay} />
                <p className='text-xs text-muted-foreground'>
                  {relay.node} · 设备 {relay.binding} · Sub{relay.sub_account} ·
                  调度{relay.sub.schedulable ? '开启' : '暂停'}
                </p>
                <p className='text-xs break-words text-muted-foreground'>
                  {relay.models.join(' · ')}
                </p>
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
                      relay.sub.shared_policy_matches === false ||
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
            </details>
          </article>
        ))}
      </div>
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

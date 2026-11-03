import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, isApiError } from '@/lib/api'
import { resetCountdown, fmtResetClock } from '@/lib/fable-status'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  canResumeSchedule,
  scheduleLabel,
  scheduleResetAt,
  relayState,
  type NativeRelay,
} from './native-relay-state'
import { RelayUsageCard, RelayUsageDetail } from './relay-usage-card'

const key = ['panel', 'native-relays'] as const
const endpoint = '/api/panel/native-relays'
const successMessage = {
  start: 'Relay 已启动并恢复调度',
  stop: 'Relay 已停止，调度已暂停',
  pause_schedule: '共享池调度已暂停，在途请求继续完成',
  resume_schedule: '共享池调度已开启，额度与安全限制仍然有效',
}

export function NativeRelays({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient()
  const now = useNow()
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
      verb: keyof typeof successMessage
    }) =>
      api(`${endpoint}/${encodeURIComponent(relay.id)}/${verb}`, {
        method: 'POST',
        body: JSON.stringify({ operation_id: crypto.randomUUID() }),
      }),
    retry: false,
    onSuccess: (_data, { verb }) => {
      toast.success(successMessage[verb])
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
            className='relative flex min-w-0 flex-col gap-2.5 rounded-[10px] bg-muted/50 p-3 ps-3.5 text-card-foreground shadow-[inset_0_0_0_1px_var(--hairline)]'
          >
            <header className='space-y-1.5'>
              <div className='flex items-center justify-between gap-2'>
                <h3
                  className='truncate text-[13px] font-semibold'
                  title={relay.name}
                >
                  {relay.name}
                </h3>
                <span className='shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs'>
                  {relayState(relay, now)}
                </span>
              </div>
              <p className='flex items-center gap-2 text-xs text-muted-foreground'>
                <span>{relay.node} · 原生</span>
                <span className='font-mono tabular-nums' title='锁定的出口 IP'>
                  {relay.guard.expected_ip}
                </span>
              </p>
            </header>
            <RelayUsageCard relay={relay} now={now} />
            <div className='hairline-t mt-auto flex min-h-9 items-center justify-between gap-2 pt-2'>
              <span className='text-xs text-muted-foreground'>
                席位{' '}
                <b className='font-mono text-foreground tabular-nums'>
                  {relay.runtime.active_requests ?? '—'}/{relay.concurrency}
                </b>
              </span>
              <div className='flex items-center gap-2'>
                <label
                  htmlFor={`schedule-${relay.id}`}
                  className='text-xs text-muted-foreground'
                  title='共享池新请求调度；不会中断在途请求或解除额度冷却'
                >
                  共享调度
                </label>
                <Switch
                  id={`schedule-${relay.id}`}
                  aria-label={`${relay.name} · 共享池调度`}
                  checked={relay.sub.schedulable === true}
                  disabled={
                    change.isPending ||
                    relay.management_unavailable ||
                    relay.sub.schedulable == null ||
                    (!relay.sub.schedulable && !canResumeSchedule(relay))
                  }
                  onCheckedChange={(checked) =>
                    change.mutate({
                      relay,
                      verb: checked ? 'resume_schedule' : 'pause_schedule',
                    })
                  }
                />
              </div>
            </div>
            <p
              className='text-xs text-muted-foreground'
              title={fmtResetClock(scheduleResetAt(relay, now)) ?? undefined}
            >
              {scheduleLabel(relay, now)}
              {relay.sub.schedulable && scheduleResetAt(relay, now)
                ? ` · ${resetCountdown(scheduleResetAt(relay, now), now)} 后到期`
                : ' · 在途请求不受影响'}
            </p>
            <details className='hairline-t pt-2 text-xs'>
              <summary className='cursor-pointer text-muted-foreground'>
                详情与控制
              </summary>
              <div className='mt-2 space-y-2'>
                <RelayUsageDetail relay={relay} />
                <p className='text-xs text-muted-foreground'>
                  {relay.node} · 设备 {relay.binding} · Sub{relay.sub_account} ·
                  调度{scheduleLabel(relay, now)}
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

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
import { StatusMark } from '@/components/status-mark'
import {
  OnboardingButton,
  OnboardingCard,
  OnboardingDialog,
  RELAY_CARD,
} from './native-relay-onboarding'
import { isOpen } from './native-relay-onboarding-state'
import {
  canResumeSchedule,
  scheduleLabel,
  scheduleResetAt,
  relayState,
  relayTone,
  type NativeRelay,
} from './native-relay-state'
import { RelayUsageCard, RelayUsageDetail } from './relay-usage-card'
import { relayKey as key, useRelayOnboarding } from './use-relay-onboarding'

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
    meta: { quiet: true },
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
  const flow = useRelayOnboarding(enabled)
  if (!enabled) return null
  const items = query.data?.items ?? []
  const joining = flow.sessions.filter(isOpen)
  // 没有 Relay 也没有启用接入入口的控制器不显示这个区块。
  if (!query.error && !items.length && !flow.view) return null
  const serving = items.filter(
    (relay) => relayState(relay, now) === '运行中'
  ).length
  return (
    <section className='mb-5 space-y-3' aria-label='原生 Relay'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex items-baseline gap-2'>
          <h2 className='font-semibold'>原生 Relay</h2>
          {items.length ? (
            <span className='text-xs text-muted-foreground tabular-nums'>
              {serving}/{items.length} 运行中
              {joining.length ? ` · ${joining.length} 个接入中` : ''}
            </span>
          ) : null}
        </div>
        <div className='flex items-center gap-2'>
          <Button
            variant='outline'
            size='sm'
            disabled={query.isFetching}
            onClick={() => {
              void query.refetch()
              void flow.refresh()
            }}
          >
            刷新状态
          </Button>
          <OnboardingButton flow={flow} />
        </div>
      </div>
      {query.error ? (
        <p
          role='status'
          className='flex flex-wrap items-center gap-2 rounded-[10px] px-3.5 py-2 text-xs shadow-[inset_0_0_0_1px_var(--hairline)]'
          style={{
            color: 'var(--status-warn)',
            backgroundColor: 'var(--status-warn-bg)',
          }}
        >
          <span>
            原生 Relay 状态暂不可用：{query.error.message}
            {items.length ? '。下面是上一次读到的状态。' : ''}
          </span>
          <button
            type='button'
            className='cursor-pointer underline underline-offset-2'
            onClick={() => void query.refetch()}
          >
            重新读取
          </button>
        </p>
      ) : null}
      {!items.length && !joining.length && !query.error ? (
        <p className='rounded-[10px] px-6 py-8 text-center text-sm text-muted-foreground shadow-[inset_0_0_0_1px_var(--hairline)]'>
          还没有原生
          Relay。添加一个席位：选出口、完成一次设备授权，其余步骤自动完成。
        </p>
      ) : null}
      <div className='grid gap-3 empty:hidden md:grid-cols-2 xl:grid-cols-3'>
        {joining.map((session) => (
          <OnboardingCard key={session.seat} session={session} flow={flow} />
        ))}
        {items.map((relay) => (
          <article key={relay.id} className={RELAY_CARD}>
            <header className='space-y-1.5'>
              <div className='flex items-center justify-between gap-2'>
                <h3
                  className='truncate text-[13px] font-semibold'
                  title={relay.name}
                >
                  {relay.name}
                </h3>
                <StatusMark tone={relayTone(relay, now)} variant='pill' />
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
      <OnboardingDialog flow={flow} />
    </section>
  )
}

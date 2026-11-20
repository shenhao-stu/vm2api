import { useState } from 'react'
import { Check, Copy, ExternalLink, Loader2, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ChoiceTiles } from '@/components/choice-tiles'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { StatusMark } from '@/components/status-mark'
import {
  authorizationRemaining,
  draftProblems,
  errorText,
  isOpen,
  phaseStates,
  sessionHeadline,
  sessionTone,
  stepLabel,
  type Draft,
  type OnboardingSession,
  type PhaseState,
} from './native-relay-onboarding-state'
import type { RelayOnboarding } from './use-relay-onboarding'

export const RELAY_CARD =
  'relative flex min-w-0 flex-col gap-2.5 rounded-[10px] bg-muted/50 p-3 ps-3.5 text-card-foreground shadow-[inset_0_0_0_1px_var(--hairline)]'

/** Relay 区块标题栏里的入口；有流程在进行时变成回到进度的入口。 */
export function OnboardingButton({ flow }: { flow: RelayOnboarding }) {
  if (!flow.view) return null
  return flow.current ? (
    <Button
      size='sm'
      variant='outline'
      onClick={() => flow.setDialog({ seat: flow.current!.seat })}
    >
      <Loader2 className='animate-spin' aria-hidden='true' />
      查看接入进度
    </Button>
  ) : (
    <Button size='sm' onClick={() => flow.setDialog({ seat: null })}>
      <Plus aria-hidden='true' />
      添加原生 Relay
    </Button>
  )
}

const SEGMENT: Record<PhaseState, string> = {
  done: 'bg-[color:var(--status-ok)]',
  running: 'bg-select-border motion-safe:animate-pulse',
  failed: 'bg-[color:var(--status-bad)]',
  pending: 'bg-foreground/10',
}

function PhaseBar({ session }: { session: OnboardingSession }) {
  const phases = phaseStates(session)
  const done = phases.filter((phase) => phase.state === 'done').length
  return (
    <div
      role='progressbar'
      aria-label='接入进度'
      aria-valuemin={0}
      aria-valuemax={phases.length}
      aria-valuenow={done}
      className='grid grid-cols-5 gap-1'
    >
      {phases.map((phase) => (
        <span
          key={phase.key}
          title={phase.title}
          className={cn('h-[5px] rounded-full', SEGMENT[phase.state])}
        />
      ))}
    </div>
  )
}

function AuthorizationLink({
  session,
  compact = false,
}: {
  session: OnboardingSession
  compact?: boolean
}) {
  const now = useNow(1000)
  const link = session.authorization?.url
  if (!link) return null
  const remaining = authorizationRemaining(session, now)
  const copy = () =>
    void navigator.clipboard
      ?.writeText(link)
      .then(() => toast.success('已复制授权链接'))
      .catch(() => toast.error('复制失败，请手动选中链接'))
  const actions = (
    <div className='flex flex-wrap items-center gap-2'>
      <Button size='sm' asChild>
        <a href={link} target='_blank' rel='noreferrer'>
          打开授权页
          <ExternalLink aria-hidden='true' />
        </a>
      </Button>
      <Button size='sm' variant='outline' onClick={copy}>
        <Copy aria-hidden='true' />
        复制链接
      </Button>
      <span className='ms-auto font-mono text-xs text-muted-foreground tabular-nums'>
        {remaining ? `剩余 ${remaining}` : '即将过期'}
      </span>
    </div>
  )
  if (compact) return actions
  return (
    <section
      aria-label='设备授权'
      className='space-y-2 rounded-lg border border-select-border bg-select-surface p-3'
    >
      <p className='text-sm font-medium text-select-fg'>
        在浏览器里完成设备授权
      </p>
      <p className='text-xs text-muted-foreground'>
        用要接入的 ReClaude
        账号打开下面的页面并确认。授权后这里会自动继续，不需要回来点任何按钮。
      </p>
      {actions}
      <p className='font-mono text-[11px] break-all text-muted-foreground'>
        {link}
      </p>
    </section>
  )
}

function PhaseIcon({
  state,
  small = false,
}: {
  state: PhaseState
  small?: boolean
}) {
  const frame = cn(
    'inline-flex shrink-0 items-center justify-center rounded-full',
    small ? 'size-4' : 'size-5'
  )
  const glyph = small ? 'size-2.5' : 'size-3'
  if (state === 'done')
    return (
      <span
        className={cn(frame, 'bg-[color:var(--status-ok-bg)]')}
        style={{ color: 'var(--status-ok)' }}
      >
        <Check className={glyph} strokeWidth={3} aria-hidden='true' />
      </span>
    )
  if (state === 'failed')
    return (
      <span
        className={cn(frame, 'bg-[color:var(--status-bad-bg)]')}
        style={{ color: 'var(--status-bad)' }}
      >
        <X className={glyph} strokeWidth={3} aria-hidden='true' />
      </span>
    )
  if (state === 'running')
    return (
      <span className={cn(frame, 'bg-select-surface text-select-fg')}>
        <Loader2 className={cn(glyph, 'animate-spin')} aria-hidden='true' />
      </span>
    )
  return (
    <span className={cn(frame, 'shadow-[inset_0_0_0_1px_var(--hairline)]')}>
      <span className='size-1.5 rounded-full bg-foreground/20' />
    </span>
  )
}

const PHASE_WORD: Record<PhaseState, string> = {
  done: '完成',
  running: '进行中',
  failed: '未完成',
  pending: '等待',
}

/** 卡片里的单行版：阶段名在左，当前子步骤或状态在右。 */
function PhaseRows({ session }: { session: OnboardingSession }) {
  return (
    <ol className='grid gap-1' aria-label='接入步骤'>
      {phaseStates(session).map((phase) => {
        const active = phase.state === 'running' || phase.state === 'failed'
        return (
          <li key={phase.key} className='flex h-5 items-center gap-2 text-xs'>
            <PhaseIcon state={phase.state} small />
            <span
              className={cn(
                'truncate',
                phase.state === 'pending'
                  ? 'text-muted-foreground'
                  : 'font-medium'
              )}
            >
              {phase.title}
            </span>
            <span
              className={cn(
                'ms-auto shrink-0 text-muted-foreground',
                phase.state === 'failed' && 'text-[color:var(--status-bad)]'
              )}
            >
              {active && phase.current
                ? stepLabel(phase.current)
                : PHASE_WORD[phase.state]}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function PhaseList({ session }: { session: OnboardingSession }) {
  return (
    <ol className='space-y-2.5' aria-label='接入步骤'>
      {phaseStates(session).map((phase) => (
        <li key={phase.key} className='flex items-start gap-2.5'>
          <PhaseIcon state={phase.state} />
          <div className='min-w-0 flex-1'>
            <p
              className={cn(
                'flex items-baseline justify-between gap-2 text-sm',
                phase.state === 'pending' && 'text-muted-foreground'
              )}
            >
              <span className='font-medium'>{phase.title}</span>
              <span className='shrink-0 text-xs text-muted-foreground'>
                {PHASE_WORD[phase.state]}
              </span>
            </p>
            <p className='text-xs text-muted-foreground'>
              {(phase.state === 'running' || phase.state === 'failed') &&
              phase.current
                ? stepLabel(phase.current)
                : phase.hint}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}

function SessionFacts({ session }: { session: OnboardingSession }) {
  const facts = [
    ['出口', session.expected_ip],
    ['组织', String(session.org)],
    ['席位', session.seat],
    ...(session.result.binding
      ? [['设备', String(session.result.binding)]]
      : []),
    ...(session.result.sub_account
      ? [['Sub', String(session.result.sub_account)]]
      : []),
  ]
  return (
    <dl className='flex flex-wrap gap-x-4 gap-y-1 text-xs'>
      {facts.map(([label, value]) => (
        <div key={label} className='flex items-baseline gap-1.5'>
          <dt className='text-muted-foreground'>{label}</dt>
          <dd className='font-mono tabular-nums'>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Relay 网格里的进行中席位，和已上线 Relay 的卡片同一套版式。 */
export function OnboardingCard({
  session,
  flow,
}: {
  session: OnboardingSession
  flow: RelayOnboarding
}) {
  const waiting = session.status === 'awaiting_authorization'
  const failed = session.status === 'failed'
  const stalled = flow.stalled && !failed
  return (
    <article className={RELAY_CARD} aria-label={`${session.name} · 接入中`}>
      <header className='space-y-1.5'>
        <div className='flex items-center justify-between gap-2'>
          <h3
            className='truncate text-[13px] font-semibold'
            title={session.name}
          >
            {session.name}
          </h3>
          <StatusMark tone={sessionTone(session)} variant='pill' />
        </div>
        <p className='flex items-center gap-2 text-xs text-muted-foreground'>
          <span>新席位 · 原生</span>
          <span className='font-mono tabular-nums' title='锁定的出口 IP'>
            {session.expected_ip}
          </span>
        </p>
      </header>
      <PhaseBar session={session} />
      <PhaseRows session={session} />
      <p
        className={cn(
          'hairline-t pt-2 text-xs',
          failed
            ? 'text-[color:var(--status-bad)]'
            : stalled
              ? 'text-[color:var(--status-warn)]'
              : 'text-muted-foreground'
        )}
      >
        {stalled
          ? '接入服务没有在运行，进度暂停更新'
          : sessionHeadline(session)}
      </p>
      <div className='hairline-t mt-auto flex min-h-9 flex-wrap items-center justify-between gap-2 pt-2'>
        {waiting ? (
          <AuthorizationLink session={session} compact />
        ) : (
          <span className='text-xs text-muted-foreground'>
            席位{' '}
            <b className='font-mono text-foreground tabular-nums'>
              {session.seat}
            </b>
          </span>
        )}
        <Button
          size='sm'
          variant='outline'
          className={waiting ? 'w-full' : undefined}
          onClick={() => flow.setDialog({ seat: session.seat })}
        >
          {failed ? '查看并处理' : '查看进度'}
        </Button>
      </div>
    </article>
  )
}

export function StartForm({ flow }: { flow: RelayOnboarding }) {
  const options = flow.view?.options ?? []
  const [typed, setTyped] = useState<Draft>({ name: '', egress: '', org: '' })
  const change = (patch: Partial<Draft>) =>
    setTyped((current) => ({ ...current, ...patch }))
  // 只有一个出口时不必再点一次；出口列表晚于表单到达时同样成立。
  const draft = {
    ...typed,
    egress: typed.egress || (options.length === 1 ? options[0].id : ''),
  }
  const [touched, setTouched] = useState(false)
  const problems = draftProblems(draft, options)
  const blocked = Object.keys(problems).length > 0
  const show = (field: keyof Draft) =>
    touched && problems[field] ? (
      <p className='text-xs text-[color:var(--status-bad)]'>
        {problems[field]}
      </p>
    ) : null
  return (
    <form
      className='space-y-4'
      onSubmit={(event) => {
        event.preventDefault()
        setTouched(true)
        if (!blocked) flow.start.mutate(draft)
      }}
    >
      <div className='space-y-1.5'>
        <Label>出口</Label>
        {options.length ? (
          <ChoiceTiles
            label='出口'
            value={draft.egress}
            onChange={(egress) => change({ egress })}
            choices={options.map((option) => ({
              value: option.id,
              title: option.label,
              detail: (
                <span className='font-mono tabular-nums'>
                  {option.expected_ip}
                </span>
              ),
            }))}
          />
        ) : (
          <p className='text-xs text-muted-foreground'>
            暂时读不到已验证的出口，请稍后再试。
          </p>
        )}
        <p className='text-xs text-muted-foreground'>
          授权和之后的全部请求都固定从这个 IP
          出站；出口一旦变化会自动停止，不会换路。
        </p>
        {show('egress')}
      </div>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-1.5'>
          <Label htmlFor='onboarding-name'>名称</Label>
          <Input
            id='onboarding-name'
            value={draft.name}
            maxLength={24}
            placeholder='例如 Ciry'
            autoComplete='off'
            aria-invalid={touched && !!problems.name}
            onChange={(event) => change({ name: event.target.value })}
          />
          {show('name')}
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='onboarding-org'>组织号</Label>
          <Input
            id='onboarding-org'
            value={draft.org}
            inputMode='numeric'
            maxLength={9}
            placeholder='ReClaude 组织编号'
            autoComplete='off'
            className='font-mono tabular-nums placeholder:font-sans'
            aria-invalid={touched && !!problems.org}
            onChange={(event) =>
              change({ org: event.target.value.replace(/\D/g, '') })
            }
          />
          {show('org')}
        </div>
      </div>
      <DialogFooter className='items-center sm:justify-between'>
        {flow.stalled ? (
          <p role='status' className='text-xs text-[color:var(--status-warn)]'>
            接入服务没有在运行，暂时不能开始；恢复后这里自动可用。
          </p>
        ) : (
          <p className='text-xs text-muted-foreground'>
            下一步会生成授权链接，你只需要完成一次网页授权。
          </p>
        )}
        <Button
          type='submit'
          disabled={flow.start.isPending || !options.length || flow.stalled}
        >
          {flow.start.isPending ? '正在提交…' : '开始授权'}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function SessionProgress({
  session,
  flow,
  onClose,
}: {
  session: OnboardingSession
  flow: RelayOnboarding
  onClose: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const failed = session.status === 'failed'
  const closed = !isOpen(session)
  const stalled = flow.stalled && !closed
  const pending = flow.change.isPending || stalled
  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <SessionFacts session={session} />
        <StatusMark tone={sessionTone(session)} variant='pill' />
      </div>
      {session.status === 'awaiting_authorization' && (
        <AuthorizationLink session={session} />
      )}
      {failed && session.error && (
        <section
          role='alert'
          className='space-y-1 rounded-lg border border-[color:var(--status-bad)]/40 bg-[color:var(--status-bad-bg)] p-3'
        >
          <p className='text-sm font-medium'>
            {stepLabel(session.error.step)}未完成
          </p>
          <p className='text-xs'>{errorText(session.error)}</p>
          <p className='font-mono text-[11px] break-all text-muted-foreground'>
            {session.error.code}
            {session.error.detail ? ` · ${session.error.detail}` : ''}
          </p>
          <p className='text-xs text-muted-foreground'>
            {session.error.retriable
              ? '已完成的步骤会保留，重试只从这一步继续。'
              : session.error.step === 'abandon'
                ? '清理没有全部完成，可以再次执行，已移除的部分不受影响。'
                : '这一步不能原地重试：放弃并清理后重新开始。'}
          </p>
        </section>
      )}
      {session.status === 'live' && (
        <section
          className='rounded-lg border border-[color:var(--status-ok)]/40 bg-[color:var(--status-ok-bg)] p-3 text-sm'
          aria-label='接入结果'
        >
          <p className='font-medium'>已上线并加入共享池</p>
          <p className='text-xs text-muted-foreground'>
            它的状态卡会出现在 Relay 列表里，可以像其他 Relay
            一样暂停调度或停止。官方 5H / 7D 读数需要另行接入读取端。
          </p>
        </section>
      )}
      <PhaseList session={session} />
      {flow.unreachable ? (
        <p className='text-xs text-[color:var(--status-warn)]'>
          暂时读不到最新进度，流程仍在后台进行，恢复后自动更新。
        </p>
      ) : stalled ? (
        <p role='status' className='text-xs text-[color:var(--status-warn)]'>
          接入服务没有在运行：进度不会前进，重试和清理暂时不可用。服务恢复后这里自动更新。
        </p>
      ) : null}
      <DialogFooter className='items-center sm:justify-between'>
        <p className='text-xs text-muted-foreground'>
          {closed || stalled
            ? ''
            : failed
              ? '流程已停在这一步，不会自行继续。'
              : '可以关闭窗口，流程在后台继续。'}
        </p>
        <div className='flex flex-wrap justify-end gap-2'>
          {!closed && session.status !== 'abandoning' && (
            <Button
              variant={failed ? 'outline' : 'ghost'}
              disabled={pending}
              onClick={() => setConfirming(true)}
            >
              放弃并清理
            </Button>
          )}
          {failed && session.error?.retriable && (
            <Button
              disabled={pending}
              onClick={() =>
                flow.change.mutate({ seat: session.seat, verb: 'retry' })
              }
            >
              重试这一步
            </Button>
          )}
          {closed && <Button onClick={onClose}>完成</Button>}
        </div>
      </DialogFooter>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        destructive
        title='放弃这次接入？'
        cancelBtnText='继续接入'
        confirmText='放弃并清理'
        desc='会移除为这个席位创建的隔离环境、网关、私有路由和 Sub2API 账号，其他 Relay 不受影响。如果设备已经授权，它在 ReClaude 网站上的设备记录需要你手动移除。'
        isLoading={flow.change.isPending}
        disabled={stalled}
        handleConfirm={() =>
          flow.change.mutate(
            { seat: session.seat, verb: 'abandon' },
            { onSettled: () => setConfirming(false) }
          )
        }
      />
    </div>
  )
}

export function OnboardingDialog({ flow }: { flow: RelayOnboarding }) {
  const open = !!flow.dialog
  const seat = flow.dialog?.seat ?? null
  const session = flow.sessions.find((item) => item.seat === seat) ?? null
  // 结束超过一天的流程不再列出；此时只说明情况，不回到空白表单。
  const gone = !!seat && !session
  const close = () => flow.setDialog(null)
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-xl'>
        <DialogHeader>
          <DialogTitle>
            {session ? `接入 ${session.name}` : '添加原生 Relay'}
          </DialogTitle>
          <DialogDescription>
            {session
              ? session.status === 'failed' && session.error
                ? `停在“${stepLabel(session.error.step)}”，原因和可选操作见下方。`
                : sessionHeadline(session)
              : gone
                ? '这次接入已经结束，不再显示进度。'
                : '在 AgentNAS 上新建一个独立席位：选出口、完成一次设备授权，其余步骤自动完成并上线。'}
          </DialogDescription>
        </DialogHeader>
        {!open ? null : session ? (
          <SessionProgress session={session} flow={flow} onClose={close} />
        ) : gone ? (
          <DialogFooter>
            <Button onClick={close}>关闭</Button>
          </DialogFooter>
        ) : (
          <StartForm flow={flow} />
        )}
      </DialogContent>
    </Dialog>
  )
}

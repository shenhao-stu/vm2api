import type { StatusTone } from '@/types/status'

export type OnboardingOption = {
  id: string
  label: string
  expected_ip: string
}

export type OnboardingStepStatus = 'pending' | 'running' | 'done' | 'failed'

export type OnboardingSession = {
  seat: string
  name: string
  egress: string
  expected_ip: string
  org: number
  created_at: number
  updated_at: number
  status:
    | 'queued'
    | 'running'
    | 'awaiting_authorization'
    | 'failed'
    | 'abandoning'
    | 'abandoned'
    | 'live'
  steps: { key: string; status: OnboardingStepStatus }[]
  /** `expires_at` 为 Unix 秒。 */
  authorization: { url: string; expires_at: number } | null
  error: {
    step: string
    code: string
    detail?: string
    retriable: boolean
  } | null
  result: { binding?: number; sub_account?: number; relay_id?: string }
}

export type OnboardingView = {
  options: OnboardingOption[]
  sessions: OnboardingSession[]
  busy: boolean
}

/** 十四个内部步骤合成管理员关心的五个阶段。 */
export const PHASES = [
  {
    key: 'prepare',
    title: '准备隔离环境',
    hint: '独立网络、防火墙与出口守卫',
    steps: ['preflight', 'prepare', 'exit_check'],
  },
  {
    key: 'authorize',
    title: '设备授权',
    hint: '由你在浏览器里确认一次',
    steps: ['login'],
  },
  {
    key: 'runtime',
    title: '启动原生环境',
    hint: '原生守护进程、工作进程与一次直连验收',
    steps: ['native', 'worker', 'native_canary'],
  },
  {
    key: 'route',
    title: '接入私有链路',
    hint: '专属网关、私有路由与 Sub2API 账号',
    steps: ['gateway', 'route', 'sub'],
  },
  {
    key: 'launch',
    title: '验收并上线',
    hint: '一次端到端计费验收后加入共享池',
    steps: ['sub_canary', 'manager', 'promote', 'live'],
  },
] as const

const STEP_LABEL: Record<string, string> = {
  preflight: '检查三台主机',
  prepare: '创建隔离网络与出口',
  exit_check: '核对出口 IP',
  login: '等待设备授权',
  native: '启动原生守护进程',
  worker: '启动工作进程',
  native_canary: '直连验收',
  gateway: '创建专属网关',
  route: '接入私有路由',
  sub: '创建 Sub2API 账号',
  sub_canary: '端到端计费验收',
  manager: '接入控制台',
  promote: '加入共享池',
  live: '标记上线',
  abandon: '清理',
}

const ERROR_TEXT: Record<string, string> = {
  egress_ip_changed: '所选出口的 IP 与确认时不一致，已停止。请重新选择出口。',
  egress_probe_failed: '出口没有返回预期的 IP，未创建任何授权。',
  exit_address_mismatch:
    '隔离环境的实际出口与预期不符，未发起授权。请检查出口后重试。',
  exit_guard_not_ready: '出口守卫未就绪或已锁存，流程已停止。',
  container_host_not_ready: 'AgentNAS 模板席位自检未通过。',
  container_shape_mismatch: '新建的容器与模板不一致，流程已停止。',
  runner_error: '执行服务在这一步遇到未预期的情况。',
  authorization_timeout: '授权链接在有效期内未完成授权。',
  login_ended: '登录进程已结束但设备没有绑定成功。',
  device_not_bound: '设备尚未绑定。',
  native_not_ready: '原生守护进程未进入健康状态。',
  worker_not_healthy: '工作进程未通过健康检查。',
  native_canary_failed: '直连验收请求未通过。',
  sub_canary_failed: '端到端验收请求未通过，席位没有加入共享池。',
  canary_attempts_exhausted: '验收请求已用完 3 次机会，不会再自动重试。',
  private_route_unreachable: 'Sub2API 无法经私有路由访问该席位。',
  public_path_open: '该席位路径在公网域名上未被屏蔽，已停止。',
  gateway_host_memory_low: '网关主机可用内存不足。',
  nginx_busy: '私有路由配置正被其他操作占用，请稍后重试。',
  release_in_progress: 'Sub2API 正在发布，请稍后重试。',
  manager_status_not_ready: '控制台读取该席位状态未就绪。',
  runner_interrupted: '执行服务在这一步期间重启。',
  host_timeout: '主机在限定时间内没有完成这一步。',
  host_unreachable: '无法连接到执行这一步的主机。',
  seat_is_live: '该席位已上线，不能通过接入流程清理。',
  onboarding_in_progress: '已有一个接入流程在进行，完成或放弃后再开始。',
  operation_already_consumed: '这次操作已提交过，请刷新状态。',
  unknown_egress: '该出口不在已验证列表中。',
  invalid_name: '名称只能包含文字、数字、空格和 . · -，最多 24 个字符。',
  invalid_org: '组织号需要是正整数。',
  retry_not_available: '当前状态不能重试这一步。',
  session_closed: '该流程已结束。',
}

/** 内部校验码很多，按所属主机归类说明；原始代码始终另行显示。 */
const ERROR_GROUPS: [RegExp, string][] = [
  [/^template_/, '模板席位与预期不一致。为避免克隆出错误的环境，流程已停止。'],
  [
    /^(gateway|unit|worker_unreachable|relay_keys)_/,
    '专属网关没有达到与模板一致的状态。',
  ],
  [
    /^(route|nginx|private_listener|ingress)_/,
    '私有路由没有按预期生效，本次修改已回滚。',
  ],
  [/^public_/, '公网屏蔽规则没有按预期生效，流程已停止。'],
  [
    /^(sub|account|acceptance|reference|routing|promotion|admin_grant)_/,
    'Sub2API 侧没有达到预期状态，席位没有加入共享池。',
  ],
  [
    /^(container|network|firewall|seat|native|exit|management|egress)_/,
    'AgentNAS 上的席位环境没有达到预期状态。',
  ],
]

export function stepLabel(key: string): string {
  return STEP_LABEL[key] ?? key
}

export function errorText(error: { code: string }): string {
  return (
    ERROR_TEXT[error.code] ??
    ERROR_GROUPS.find(([pattern]) => pattern.test(error.code))?.[1] ??
    '这一步没有完成。'
  )
}

export function isOpen(session: OnboardingSession): boolean {
  return session.status !== 'live' && session.status !== 'abandoned'
}

export type PhaseState = 'pending' | 'running' | 'done' | 'failed'

export function phaseStates(session: OnboardingSession) {
  const status = new Map(session.steps.map((step) => [step.key, step.status]))
  return PHASES.map((phase) => {
    const states = phase.steps.map((key) => status.get(key) ?? 'pending')
    const state: PhaseState = states.includes('failed')
      ? 'failed'
      : states.every((value) => value === 'done')
        ? 'done'
        : states.some((value) => value !== 'pending')
          ? 'running'
          : 'pending'
    const current =
      phase.steps.find((key) => status.get(key) === 'failed') ??
      phase.steps.find((key) => status.get(key) === 'running') ??
      phase.steps.find((key) => status.get(key) !== 'done')
    return { ...phase, state, current }
  })
}

/** 已完成步骤数 / 总步骤数，用于卡片上的进度条。 */
export function progress(session: OnboardingSession) {
  const done = session.steps.filter((step) => step.status === 'done').length
  return { done, total: session.steps.length }
}

export function sessionTone(session: OnboardingSession): StatusTone {
  const tone = (cls: string, text: string): StatusTone => ({
    key: session.status,
    cls,
    text,
  })
  switch (session.status) {
    case 'live':
      return tone('ok', '已上线')
    case 'awaiting_authorization':
      return tone('caution', '等待授权')
    case 'failed':
      return tone(
        'bad',
        session.error?.step === 'abandon' ? '清理未完成' : '已停止'
      )
    case 'abandoning':
      return tone('none', '清理中')
    case 'abandoned':
      return tone('off', '已放弃')
    case 'queued':
      return tone('none', '排队中')
    default:
      return tone('none', '接入中')
  }
}

/** 卡片与弹窗共用的一句话现状。 */
export function sessionHeadline(session: OnboardingSession): string {
  if (session.status === 'failed' && session.error)
    return `${stepLabel(session.error.step)}：${errorText(session.error)}`
  if (session.status === 'awaiting_authorization')
    return '打开授权页面完成授权，之后的步骤自动进行'
  if (session.status === 'live') return '已加入共享池并开始接单'
  if (session.status === 'abandoned') return '已清理，未留下任何调度入口'
  if (session.status === 'abandoning') return '正在移除已创建的资源'
  if (session.status === 'queued') return '等待执行服务接手'
  const running = session.steps.find((step) => step.status === 'running')
  return running ? `${stepLabel(running.key)}…` : '准备下一步…'
}

/** 授权链接剩余时间，`mm:ss`；过期返回 null。 */
export function authorizationRemaining(
  session: OnboardingSession,
  now: number
): string | null {
  const expires = session.authorization?.expires_at
  if (!expires) return null
  const seconds = Math.floor(expires - now / 1000)
  if (seconds <= 0) return null
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`
}

const NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_ .·-]{0,23}$/u

export type Draft = { name: string; egress: string; org: string }

/** 与服务端相同的输入规则；返回每个字段的问题，空对象表示可以提交。 */
export function draftProblems(
  draft: Draft,
  options: OnboardingOption[]
): Partial<Record<keyof Draft, string>> {
  const problems: Partial<Record<keyof Draft, string>> = {}
  const name = draft.name
  if (!name) problems.name = '给这个席位起个名字'
  else if (name !== name.trim() || !NAME.test(name))
    problems.name = ERROR_TEXT.invalid_name
  if (!options.some((option) => option.id === draft.egress))
    problems.egress = '选择一个出口'
  if (!/^[1-9]\d{0,8}$/.test(draft.org)) problems.org = ERROR_TEXT.invalid_org
  return problems
}

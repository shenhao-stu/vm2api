export type QualityProbeConfig = {
  enabled: boolean
  interval_minutes: number
  model: string
  failure_threshold: number
  concurrency: number
  prompt: string
  expected_answer: string
}
export type QualityRecoveryEvent = {
  at: string
  event: string
  result: string | null
  next_at: string | null
  reason: string | null
}
export type QualityProbeItem = {
  vm_id: string
  vm_name: string | null
  paused: boolean
  consecutive_wrong: number
  last_result: string | null
  last_error: string | null
  last_answer?: string | null
  last_test_at?: string | null
  upstream_model: string | null
  safety_buffering: boolean | null
  safety_buffering_enabled?: string | null
  safety_buffering_faster_model?: string | null
  signal_test_at?: string | null
  recovery_phase: string | null
  recovery_next_at: string | null
  recovery_history?: QualityRecoveryEvent[]
}
export type QualityProbeView = {
  config: QualityProbeConfig
  manual_run_allowed?: boolean
  progress: {
    running: boolean
    completed: number
    total: number
    next_run_at?: string | null
    started_at?: string | null
    finished_at?: string | null
  }
  items: QualityProbeItem[]
}
export const qualityQueryKey = ['panel', 'quality-probe'] as const
export const qualityEndpoint = '/api/panel/quality-probe'
export const qualityPauseReason = 'quality_probe_failed'
export const qualityResultLabels: Record<string, string> = {
  correct: '答对',
  wrong: '答错',
  error: '请求失败 · 不计错',
  invalid: '无效答案 · 不计错',
  skipped: '已跳过 · 不计错',
  blocked: '条件未满足 · 不计错',
}
export function qualityTime(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—'
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
export function safetyLabel(flag: boolean | null) {
  return flag === true ? '已触发' : flag === false ? '未触发' : '未知 · 未提供'
}

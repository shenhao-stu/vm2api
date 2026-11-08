// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import {
  qualityQueryKey,
  type QualityProbeView,
} from '@/features/settings/quality-probe-data'
import { CodexQualityCard } from './codex-quality-card'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let cleanup = async () => {}
afterEach(async () => {
  await cleanup()
  vi.clearAllMocks()
})
const fixture = (): QualityProbeView => ({
  config: {
    enabled: true,
    interval_minutes: 60,
    concurrency: 1,
    model: 'gpt-6.1-sol',
    failure_threshold: 2,
    prompt: 'test',
    expected_answer: '21',
  },
  progress: {
    running: false,
    completed: 4,
    total: 4,
    next_run_at: '2026-11-09T00:00:00Z',
    finished_at: '2026-11-08T23:00:00Z',
  },
  items: [
    {
      vm_id: 'codex-04',
      vm_name: '账号04',
      paused: true,
      consecutive_wrong: 2,
      last_result: 'error',
      last_error: '上游超时',
      upstream_model: 'gpt-6.1-sol',
      safety_buffering: null,
      safety_buffering_faster_model: 'gpt-6-luna',
      recovery_phase: 'confirming',
      recovery_next_at: '2026-11-09T00:10:00Z',
      recovery_history: [
        {
          at: '2026-11-08T23:00:00Z',
          event: 'first_pass',
          result: 'correct',
          next_at: '2026-11-09T00:10:00Z',
          reason: null,
        },
      ],
    },
  ],
})
async function mount(data = fixture()) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  })
  qc.setQueryData(qualityQueryKey, data)
  vi.mocked(api).mockResolvedValue(data)
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <CodexQualityCard />
      </QueryClientProvider>
    )
  )
  cleanup = async () => {
    await act(async () => root.unmount())
    qc.clear()
    node.remove()
  }
  return node
}
it('exposes both signals and the native rest journal without triggering models or losing the wrong streak', async () => {
  const node = await mount()
  for (const label of [
    'GPT 答题质量探测',
    '请求失败 · 不计错',
    '未知 · 未提供',
    '配置备用：gpt-6-luna',
    '2 / 2',
    '质量暂停 1 个',
    '待恢复 1 个',
    '恢复日志（1）',
    '待二次确认',
    '下次探测',
  ])
    expect(node.textContent).toContain(label)
  expect(node.querySelectorAll('th')).toHaveLength(8)
  expect(api).not.toHaveBeenCalled()
})
it('manual recovery uses the native compare-and-set endpoint and never clears a different hold', async () => {
  const node = await mount()
  await act(async () =>
    [...node.querySelectorAll('button')]
      .find((b) => b.textContent === '手动恢复')!
      .click()
  )
  expect(api).not.toHaveBeenCalled()
  vi.mocked(api).mockRejectedValue(new Error('账号暂停原因已变化'))
  await act(async () =>
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent === '仅解除质量暂停')!
      .click()
  )
  expect(api).toHaveBeenCalledExactlyOnceWith(
    '/api/panel/vms/codex-04/schedulable',
    {
      method: 'POST',
      body: JSON.stringify({
        schedulable: true,
        expected_reason: 'quality_probe_failed',
      }),
    }
  )
  await vi.waitFor(() =>
    expect(node.textContent).toContain('账号暂停原因已变化')
  )
  expect(node.textContent).toContain('质量暂停 1 个')
})
it('manual mode is explicit and an active round cannot be dispatched twice', async () => {
  const data = fixture()
  data.config.enabled = false
  data.manual_run_allowed = true
  data.progress.running = true
  const node = await mount(data)
  const button = [...node.querySelectorAll('button')].find(
    (b) => b.textContent === '立即探测（使用额度）'
  )!
  expect(button.disabled).toBe(true)
  expect(api).not.toHaveBeenCalled()
})

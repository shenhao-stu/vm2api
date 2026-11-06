// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { QualityProbePane, type QualityProbeView } from './quality-probe-pane'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let cleanup = async () => {}
afterEach(async () => {
  await cleanup()
  vi.clearAllMocks()
})

async function mount() {
  const data: QualityProbeView = {
    config: {
      enabled: false,
      interval_minutes: 15,
      concurrency: 1,
      failure_threshold: 2,
      model: 'gpt-5.4',
      prompt: '1+1?',
      expected_answer: '2',
    },
    progress: { running: false, completed: 0, total: 1 },
    items: [
      {
        vm_id: 'account',
        vm_name: '账号一',
        paused: true,
        consecutive_wrong: 2,
        last_result: 'wrong',
        last_error: null,
        upstream_model: null,
        safety_buffering: null,
        recovery_phase: 'cooldown',
        recovery_next_at: '2026-11-07T00:00:00Z',
      },
    ],
  }
  const qc = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, retry: false, gcTime: Infinity },
    },
  })
  qc.setQueryData(['panel', 'quality-probe'], data)
  vi.mocked(api).mockImplementation(async (_url, opts) =>
    opts?.method === 'PUT'
      ? { ...data, config: JSON.parse(String(opts.body)) }
      : data
  )
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <QualityProbePane />
      </QueryClientProvider>
    )
  })
  cleanup = async () => {
    await act(async () => root.unmount())
    qc.clear()
    container.remove()
  }
  return container
}

it('reports uncertainty and the rest deadline without scheduling a probe on mount', async () => {
  const node = await mount()
  expect(node.textContent).toContain('安全缓冲：未知')
  expect(node.textContent).toContain('静置后复测')
  expect(node.textContent).toContain('不能证明模型身份')
  const run = [...node.querySelectorAll('button')].find(
    (button) => button.textContent === '立即检测'
  )!
  expect(run.disabled).toBe(true)
  expect(api).not.toHaveBeenCalled()
})

it('requires an explicit save before enabling a paid probe', async () => {
  const node = await mount()
  await act(async () => {
    node.querySelector<HTMLButtonElement>('[role="switch"]')!.click()
  })
  const buttons = [...node.querySelectorAll('button')]
  const run = buttons.find((button) => button.textContent === '立即检测')!
  expect(run.disabled).toBe(true)
  await act(async () => {
    buttons.find((button) => button.textContent === '保存检测配置')!.click()
  })
  expect(vi.mocked(api).mock.calls[0][0]).toBe('/api/panel/quality-probe')
  expect(
    JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body)).enabled
  ).toBe(true)
  expect(run.disabled).toBe(false)
  expect(api).toHaveBeenCalledTimes(1)
})

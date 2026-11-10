// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import {
  FABLE_PRO_START,
  FABLE_PRO_END,
} from '../../../../src/lib/pool/claude-fable-promotion.mjs'
import { AllowedModelsCard } from './allowed-models-card'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let cleanup = async () => {}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(FABLE_PRO_START + 1000)
})
afterEach(async () => {
  await cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

async function mount(patch: Partial<Vm> = {}) {
  const vm = {
    id: 'pro',
    has_token: true,
    subscription_type: 'pro',
    allowed_models: ['claude-sonnet-5-5', 'claude-fable-5-2'],
    ...patch,
  } as Vm
  const qc = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  })
  qc.setQueryData(['panel', 'me'], { role: 'admin' })
  qc.setQueryData(['panel', 'model-policy', 'anthropic'], {
    models: [
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-fable-5-2',
    ].map((id) => ({ id })),
  })
  vi.mocked(api).mockResolvedValue({})
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <AllowedModelsCard vm={vm} />
      </QueryClientProvider>
    )
  )
  cleanup = async () => {
    await act(async () => root.unmount())
    qc.clear()
    node.remove()
  }
  const checkbox = (id: string) =>
    node.querySelector<HTMLButtonElement>(`#slot-model-${id}`)!
  return { node, checkbox }
}

it('keeps only promotional Fable5.2 selectable and preserves it when another model is removed', async () => {
  const { node, checkbox } = await mount()
  expect(node.textContent).toContain('Pro 活动期间仅开放 Fable 5.2')
  expect(checkbox('claude-fable-5').disabled).toBe(true)
  expect(checkbox('claude-fable-5-1').disabled).toBe(true)
  expect(checkbox('claude-fable-5-2').disabled).toBe(false)
  expect(checkbox('claude-fable-5-2').getAttribute('aria-checked')).toBe('true')
  await act(async () => checkbox('claude-sonnet-5-5').click())
  expect(api).toHaveBeenCalledExactlyOnceWith('/api/panel/vms/pro', {
    method: 'PATCH',
    body: JSON.stringify({ allowed_models: ['claude-fable-5-2'] }),
  })
})

it('blocks an expired stale checkbox immediately and updates the visible affordance on the existing UI clock', async () => {
  const { node, checkbox } = await mount()
  vi.setSystemTime(FABLE_PRO_END)
  await act(async () => checkbox('claude-fable-5-2').click())
  expect(api).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledWith('当前套餐或活动时间不允许此模型')
  await act(async () => vi.advanceTimersByTime(30_000))
  expect(checkbox('claude-fable-5-2').disabled).toBe(true)
  expect(node.textContent).toContain('Pro 当前未开放 Fable')
})

it('does not turn an empty model selection into unrestricted inheritance', async () => {
  const { checkbox } = await mount({ allowed_models: ['claude-fable-5-2'] })
  await act(async () => checkbox('claude-fable-5-2').click())
  expect(api).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledWith(
    '至少保留一个可用模型；停用账号请关闭调度'
  )
})

it('keeps explicit inheritance and all Max Fable versions available', async () => {
  vi.setSystemTime(FABLE_PRO_END + 1)
  const { node, checkbox } = await mount({ subscription_type: 'max' })
  for (const id of ['claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2'])
    expect(checkbox(id).disabled).toBe(false)
  await act(async () =>
    [...node.querySelectorAll('button')]
      .find((button) => button.textContent === '全选（继承）')!
      .click()
  )
  expect(api).toHaveBeenCalledExactlyOnceWith('/api/panel/vms/pro', {
    method: 'PATCH',
    body: JSON.stringify({ allowed_models: null }),
  })
})

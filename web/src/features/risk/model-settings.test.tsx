// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { JevInterceptConfig } from '@/types/panel-routing'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { ModelSettings } from './model-settings'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let cleanup = async () => {}
afterEach(async () => {
  await cleanup()
  vi.clearAllMocks()
})

async function mount() {
  const data = {
    enabled: true,
    provider: 'jev',
    base_url: 'https://api.typesafe.ai',
    model: 'jev-latest',
    api_key_set: true,
    api_key_count: 2,
    api_key_ready_count: 1,
    api_key_cooling_count: 1,
    timeout_ms: 2000,
    fail_open: false,
    safety_threshold: 0.5,
    block_if_below: true,
    dedup_sec: 60,
    max_state_chars: 16000,
    question_bank: [],
  } as unknown as JevInterceptConfig
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, retry: false, gcTime: Infinity },
    },
  })
  client.setQueryData(['panel', 'jev-intercept'], data)
  vi.mocked(api).mockResolvedValue({ ...data, api_key_count: 50 })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  cleanup = async () => {
    await act(async () => root.unmount())
    client.clear()
    container.remove()
  }
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ModelSettings onDirtyChange={() => {}} />
      </QueryClientProvider>
    )
  )
  const input = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="多把 Key"]'
  )!
  const fill = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const save = () =>
    [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '保存'
    )!
  return { container, fill, save }
}

it('shows exact import count, merges explicit duplicates, and saves 50 keys without weakening review', async () => {
  const ui = await mount()
  expect(ui.container.textContent).toContain('已存 2 把 · 可调度 1 把')
  const exported = Array.from(
    { length: 50 },
    (_, i) => `APIKEY:synthetic-ui-${i} 临时邮箱:synthetic-${i}@example.invalid`
  ).join('\n')
  await ui.fill(`${exported}\nAPIKEY:synthetic-ui-0`)
  expect(ui.container.textContent).toContain(
    '共 51 行，识别 50 把有效 Key，重复 1 行将合并'
  )
  expect(ui.save().disabled).toBe(false)
  await act(async () => {
    ui.save().click()
  })
  const body = JSON.parse(vi.mocked(api).mock.calls[0][1]!.body as string)
  expect(body.api_keys).toHaveLength(50)
  expect(body.api_keys[0]).toBe('synthetic-ui-0')
  expect(JSON.stringify(body.api_keys)).not.toContain('@')
  expect(body.enabled).toBe(true)
  expect(body.fail_open).toBe(false)
  expect(body.safety_threshold).toBe(0.5)
})

it('blocks malformed lines and excess keys instead of silently truncating or saving partial input', async () => {
  const ui = await mount()
  await ui.fill('APIKEY:valid\nAPIKEY:\nBearer not-a-key')
  expect(ui.container.textContent).toContain('第 2、3 行格式不正确')
  expect(ui.save().disabled).toBe(true)
  await ui.fill(
    Array.from({ length: 1000 }, (_, i) => `APIKEY:key-${i}`).join('\n')
  )
  expect(ui.container.textContent).toContain('有效 Key 共 1000 把，最多 999 把')
  expect(ui.save().disabled).toBe(true)
  expect(api).not.toHaveBeenCalled()
})

it('reads APIKEY text exports locally and previews every row before saving', async () => {
  const ui = await mount()
  const file = new File(
    [Array.from({ length: 100 }, (_, i) => `APIKEY:file-${i}`).join('\n')],
    'keys.txt',
    { type: 'text/plain' }
  )
  const input = ui.container.querySelector<HTMLInputElement>('#jev-key-file')!
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(ui.container.textContent).toContain('共 100 行，识别 100 把有效 Key')
  expect(ui.save().disabled).toBe(false)
  expect(api).not.toHaveBeenCalled()
})

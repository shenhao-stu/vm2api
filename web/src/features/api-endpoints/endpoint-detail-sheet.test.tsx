// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { EndpointDetailSheet } from './endpoint-detail-sheet'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let cleanup = async () => {}
afterEach(async () => {
  await cleanup()
  vi.clearAllMocks()
})

it('edits a local gateway without exposing unsupported options or replacing its credentials', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  cleanup = async () => {
    await act(async () => root.unmount())
    client.clear()
    container.remove()
  }
  vi.mocked(api).mockResolvedValue({ ok: true })
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <EndpointDetailSheet
          open
          onOpenChange={() => {}}
          presets={[]}
          endpoint={{
            id: 'ep_0123456789ab',
            kind: 'local_gateway',
            protocol: 'openai',
            name: 'GPT loopback',
            base_url: 'http://127.0.0.1:8787',
            auth_scheme: 'authorization_bearer',
            api_key_entries: [{ id: 'ek_stored', api_key: 'mask…tail' }],
            models: [{ name: 'gpt-5.4', alias: 'gpt-5.4' }],
          }}
        />
      </QueryClientProvider>
    )
  )
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="本机网关地址"]')
      ?.value
  ).toBe('http://127.0.0.1:8787')
  expect(document.body.textContent).not.toContain('获取模型')
  expect(document.querySelector('textarea')).toBeNull()
  expect(document.querySelector('input[placeholder^="socks5"]')).toBeNull()
  const save = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === '保存'
  )!
  await act(async () => save.click())
  expect(api).toHaveBeenCalledTimes(1)
  const body = JSON.parse(vi.mocked(api).mock.calls[0][1]!.body as string)
  expect(body).toMatchObject({
    kind: 'local_gateway',
    protocol: 'openai',
    base_url: 'http://127.0.0.1:8787',
    models: [{ name: 'gpt-5.4', alias: 'gpt-5.4' }],
  })
  expect(body).not.toHaveProperty('api_key_entries')
})

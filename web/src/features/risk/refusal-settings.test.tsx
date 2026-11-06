// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { refusalGuardsQueryOptions } from './queries'
import { RefusalSettings } from './refusal-settings'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

it('only exposes supported Pro quarantine and updates it independently of fingerprint blocking', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  })
  const key = refusalGuardsQueryOptions().queryKey
  const legacy = {
    enabled: false,
    similarity_enabled: true,
    similarity: 90,
    device_block_enabled: true,
    count: 0,
    items: [],
    device_count: 0,
    devices: [],
  }
  client.setQueryData(key, legacy)
  const host = document.createElement('div')
  const root = createRoot(host)
  const toggle = () =>
    host.querySelector<HTMLButtonElement>(
      '[aria-label="Claude Pro 拒绝后隔离会话"]'
    )
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RefusalSettings />
        </QueryClientProvider>
      )
    )
    expect(toggle()).toBeNull()

    await act(async () => {
      client.setQueryData(key, { ...legacy, session_quarantine_enabled: true })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(toggle()?.getAttribute('aria-checked')).toBe('true')
    expect(toggle()?.disabled).toBe(false)
    vi.mocked(api).mockResolvedValue({
      ...legacy,
      session_quarantine_enabled: false,
    })
    await act(async () => toggle()!.click())
    expect(api).toHaveBeenCalledExactlyOnceWith('/api/panel/refusal-guards', {
      method: 'PUT',
      body: JSON.stringify({ session_quarantine_enabled: false }),
    })
  } finally {
    await act(async () => root.unmount())
    client.clear()
    vi.clearAllMocks()
  }
})

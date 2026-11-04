// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
import { afterEach, expect, it, vi } from 'vitest'
import { copyText } from '@/lib/clipboard'
import { KeyConnectionGuide } from './key-connection-guide'

vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let cleanup = async () => {}
afterEach(async () => {
  await cleanup()
  vi.clearAllMocks()
})

it.each([true, false])(
  'copies only the mounted API URL and reports clipboard outcome %s',
  async (copied) => {
    const url = 'https://example.test/claude/v1'
    vi.mocked(copyText).mockResolvedValue(copied)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    cleanup = async () => {
      await act(async () => root.unmount())
      host.remove()
    }
    await act(async () => root.render(<KeyConnectionGuide baseUrl={url} />))
    expect(host.querySelector('code')?.textContent).toBe(url)
    await act(async () => host.querySelector('button')!.click())
    expect(copyText).toHaveBeenCalledExactlyOnceWith(url)
    expect(toast.success).toHaveBeenCalledTimes(copied ? 1 : 0)
    expect(toast.error).toHaveBeenCalledTimes(copied ? 0 : 1)
  }
)

// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { GPT_CONSOLE_URL } from '@/config/hosted'
import { afterEach, expect, it, vi } from 'vitest'
import { HostedServices } from './hosted-services'

const state = vi.hoisted(() => ({
  me: { views: undefined as string[] | undefined },
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (select: (value: typeof state) => unknown) => select(state),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let cleanup = async () => {}
afterEach(async () => {
  await cleanup()
  state.me.views = undefined
})

async function render(views?: string[]) {
  state.me.views = views
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  cleanup = async () => {
    await act(async () => root.unmount())
    host.remove()
  }
  await act(async () => root.render(<HostedServices />))
  return host
}

it('offers the exact GPT source console without forwarding current URL or credentials', async () => {
  const host = await render()
  const links = [...host.querySelectorAll('a')].map((link) =>
    link.getAttribute('href')
  )
  expect(links).toEqual(['/vm', '/keys', GPT_CONSOLE_URL])
  expect(host.textContent).toContain('原生 Key 和 API 地址单独管理')
})

it('uses the same capability list as the sidebar for Claude actions', async () => {
  const host = await render(['overview', 'keys'])
  expect(host.querySelector('a[href="/vm"]')).toBeNull()
  expect(host.querySelector('a[href="/keys"]')).not.toBeNull()
})

it('does not grant native management links for an explicit empty capability list', async () => {
  const host = await render([])
  expect(host.querySelectorAll('a').length).toBe(1)
  expect(host.querySelector('a')?.getAttribute('href')).toBe(GPT_CONSOLE_URL)
})

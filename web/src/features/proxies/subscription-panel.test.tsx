import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SubscriptionPanel } from './subscription-panel'

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (select: (state: { me: { role: string } }) => unknown) =>
    select({ me: { role: 'admin' } }),
}))

function render(overrides: Record<string, unknown> = {}, available = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(['panel', 'proxy-subscriptions'], {
    runtime: { available, running: available },
    profiles: [
      {
        id: 'sub-fixture',
        name: 'airport',
        source: 'url',
        node_count: 2,
        retained_count: 0,
        auto_refresh: true,
        refresh_interval_minutes: 360,
        ...overrides,
      },
    ],
  })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <SubscriptionPanel />
      </QueryClientProvider>
    )
  } finally {
    client.clear()
  }
}

describe('unified subscription panel', () => {
  it('offers one subscription UI with scheduling, immediate refresh and explicit reimport', () => {
    const html = render()
    expect(html).toContain('暂停自动刷新')
    expect(html).toContain('重新导入')
    expect(html).toContain('刷新 airport')
    expect(html).toContain('value="360"')
    expect(html).toContain('min="15"')
    expect(html).toContain('max="10080"')
    expect(html).not.toContain('value="https://')
  })
  it('explains bound route protection and allows resuming a paused URL source', () => {
    const html = render({
      auto_refresh: false,
      last_error: 'subscription_bound_changed',
    })
    expect(html).toContain('开启自动刷新')
    expect(html).toContain('已保留原配置')
    expect(html).toContain('手动重新导入')
  })
  it('does not offer a URL schedule for pasted content', () => {
    const html = render({ source: 'text', auto_refresh: false })
    expect(html).not.toContain('开启自动刷新')
    expect(html).not.toContain('刷新间隔')
    expect(html).toContain('刷新 airport')
  })
  it('disables refresh when managed runtime is unavailable', () => {
    const html = render({}, false)
    const button = html
      .match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
      ?.find((entry) => entry.includes('aria-label="刷新 airport"'))
    expect(button).toMatch(/\sdisabled=""/)
  })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Window } from 'happy-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { relayState, type NativeRelay } from './native-relay-state'
import { NativeRelays } from './native-relays'

const relay: NativeRelay = {
  id: 'native-fixture',
  name: 'ReClaude fixture',
  node: 'isolated',
  binding: 1,
  sub_account: 42,
  concurrency: 10,
  models: ['claude-fable-5-1'],
  observed_at: 1,
  authorization_latched: false,
  guard: { ready: true, latched: false, expected_ip: '203.0.113.1' },
  runtime: {
    container_running: true,
    http_active: true,
    http_ready: true,
    active_requests: 0,
    revoked: false,
    auth_latched: false,
    failed_checks: [],
  },
  sub: { schedulable: true },
}

describe('native Relay VM management', () => {
  it('distinguishes runtime, scheduling, exit and authorization state', () => {
    expect(relayState(relay)).toBe('运行中')
    expect(relayState({ ...relay, sub: { schedulable: false } })).toBe('已暂停')
    expect(
      relayState({ ...relay, guard: { ...relay.guard, ready: false } })
    ).toBe('出口待检查')
    expect(relayState({ ...relay, authorization_latched: true })).toBe(
      '授权锁存'
    )
  })
  function render(enabled: boolean, item = relay) {
    const client = new QueryClient()
    client.setQueryData(['panel', 'native-relays'], { items: [item] })
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <NativeRelays enabled={enabled} />
      </QueryClientProvider>
    )
  }
  it('exposes the separate runtime with Fable, controls and logs to admins', () => {
    const html = render(true)
    for (const text of [
      'ReClaude fixture',
      'claude-fable-5-1',
      '查看日志',
      '启动 Relay',
      '停止 Relay',
      '203.0.113.1',
    ]) {
      expect(html).toContain(text)
    }
    expect(html).not.toContain('重建')
    expect(html).not.toContain('删除')
  })
  it('does not show the administrative runtime to non-admins', () => {
    expect(render(false)).toBe('')
  })
  it('disables start while the authorization is latched', () => {
    const html = render(true, { ...relay, authorization_latched: true })
    const window = new Window()
    window.document.body.innerHTML = html
    const start = [...window.document.querySelectorAll('button')].find(
      (button) => button.textContent === '启动 Relay'
    )
    expect(start?.disabled).toBe(true)
  })
})

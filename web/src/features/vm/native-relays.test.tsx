import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Window } from 'happy-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  canResumeSchedule,
  scheduleLabel,
  relayState,
  scheduleResetAt,
  type NativeRelay,
} from './native-relay-state'
import { NativeRelays } from './native-relays'
import { relayUsageModel } from './relay-usage-model'

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
  it('keeps scheduling separate from lifecycle and native cooldown', () => {
    expect(canResumeSchedule(relay)).toBe(true)
    expect(canResumeSchedule({ ...relay, authorization_latched: true })).toBe(
      false
    )
    expect(
      canResumeSchedule({
        ...relay,
        runtime: { ...relay.runtime, management_paused: true },
      })
    ).toBe(false)
    expect(
      canResumeSchedule({
        ...relay,
        runtime: { ...relay.runtime, http_active: false },
      })
    ).toBe(false)
    const limited = {
      ...relay,
      sub: { schedulable: true, rate_limit_reset_at: '2099-01-01T00:00:00Z' },
    }
    expect(scheduleLabel(limited)).toBe('冷却中')
    expect(
      scheduleLabel({ ...limited, sub: { ...limited.sub, schedulable: false } })
    ).toBe('已暂停')
    expect(scheduleLabel({ ...relay, sub: { schedulable: null } })).toBe(
      '状态未知'
    )
  })
  it('renders one independent scheduling switch per account without hiding usage', () => {
    const second = {
      ...relay,
      id: 'second',
      name: 'Second',
      sub_account: 43,
      sub: { schedulable: false },
    }
    const doc = new Window().document
    doc.body.innerHTML = render(true, relay, [second])
    const switches = doc.querySelectorAll('button[role="switch"]')
    expect(switches).toHaveLength(2)
    expect(switches[0].getAttribute('aria-checked')).toBe('true')
    expect(switches[1].getAttribute('aria-checked')).toBe('false')
    expect(switches[0].id).not.toBe(switches[1].id)
    const stopped = {
      ...relay,
      sub: { schedulable: false },
      runtime: { ...relay.runtime, http_active: false },
    }
    doc.body.innerHTML = render(true, stopped)
    expect(
      doc.querySelector('button[role="switch"]')?.hasAttribute('disabled')
    ).toBe(true)
  })
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
  function render(enabled: boolean, item = relay, extra: NativeRelay[] = []) {
    const client = new QueryClient()
    client.setQueryData(['panel', 'native-relays'], { items: [item, ...extra] })
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
  it('separates Relay metering and the dated official quota', () => {
    const html = render(true, {
      ...relay,
      usage: {
        total_usd: 12.5,
        last_5h_usd: 1.25,
        last_7d_usd: 7.25,
        unpriced_requests: 1,
        first_at: null,
      },
      official_quota: {
        used_usd: 81,
        quota_usd: 80,
        observed_at_ms: 1000,
        resets_at_ms: 2000,
        stale: true,
      },
    })
    for (const value of ['1.25', '12.5', '81', '80', '缺少计价', '待更新']) {
      expect(html).toContain(value)
    }
    const doc = new Window().document
    doc.body.innerHTML = html
    expect(doc.querySelectorAll('[role=meter]')).toHaveLength(0)
    expect(doc.body.textContent).toContain('$81.00 / $80.00')
    expect(doc.body.textContent).not.toContain('0%')
    expect(doc.body.textContent).toContain('$7.25')
    expect(render(true)).toContain('官方未提供 5H / 7D 百分比')
  })
  it('keeps personal percentage windows separate from the other account', () => {
    const personal = {
      ...relay,
      id: 'second',
      name: 'Personal Max fixture',
      binding: 2,
      sub_account: 52,
      runtime: {
        ...relay.runtime,
        official_windows: {
          five_hour: { used_percent: 17, resets_at_ms: 2000 },
          seven_day: { used_percent: 98, resets_at_ms: 3000 },
          observed_at_ms: 1000,
          source_updated_ms: 800,
          stale: false,
        },
      },
    }
    const doc = new Window().document
    doc.body.innerHTML = render(true, relay, [personal])
    const cards = doc.querySelectorAll('article')
    expect(cards).toHaveLength(2)
    expect(cards[0].textContent).not.toContain('98%')
    expect(cards[1].textContent).toContain('98%')
    expect(cards[1].querySelectorAll('[role=meter]')).toHaveLength(2)
    expect(cards[1].querySelectorAll('progress')).toHaveLength(0)
    for (const card of cards) {
      const quota = card.querySelector('[aria-label="ReClaude 官方套餐窗口"]')
      expect(quota?.textContent).toContain('5H')
      expect(quota?.textContent).toContain('7D')
      expect(quota?.textContent).toContain('套餐')
    }
  })
  it('does not turn unknown scheduling or an exit latch into ready', () => {
    expect(relayState({ ...relay, sub: { schedulable: null } })).toBe(
      '调度状态未知'
    )
    expect(
      relayState({ ...relay, guard: { ...relay.guard, latched: true } })
    ).toBe('出口待检查')
    expect(
      relayState({
        ...relay,
        runtime: { ...relay.runtime, container_running: false },
      })
    ).toBe('原生环境待检查')
    const a = Date.parse('2026-11-04T02:00:00+08:00')
    const b = Date.parse('2026-11-04T11:00:00+08:00')
    const limited = {
      ...relay,
      sub: {
        schedulable: true,
        rate_limit_reset_at: new Date(a).toISOString(),
        temp_unschedulable_until: new Date(b).toISOString(),
      },
    }
    expect(scheduleResetAt(limited, a)).toBe(b)
    expect(relayState(limited, a)).toBe('额度冷却')
    expect(relayState(limited, b)).toBe('运行中')
    expect(scheduleResetAt(limited, b)).toBeNull()
  })
  it('preserves unknown versus zero and the last reading after reset', () => {
    const item = {
      ...relay,
      runtime: {
        ...relay.runtime,
        official_windows: {
          five_hour: { used_percent: 0, resets_at_ms: 1800000000000 },
          seven_day: { used_percent: 105, resets_at_ms: 1800000000001 },
          observed_at_ms: 1799999999000,
          source_updated_ms: 1799999999000,
          stale: false,
        },
      },
    }
    const before = relayUsageModel(item, 1799999999999)
    const after = relayUsageModel(item, 1800000000002)
    expect(before.stale).toBe(false)
    expect(after.stale).toBe(true)
    expect(after.windows.map((w) => w.pct)).toEqual([0, 105])
    expect(
      relayUsageModel(relay, 1800000000002).windows.map((w) => w.pct)
    ).toEqual([null, null])
    const doc = new Window().document
    doc.body.innerHTML = render(true, item)
    expect(
      [...doc.querySelectorAll('[role=meter]')].map((m) =>
        m.getAttribute('aria-valuenow')
      )
    ).toEqual(['0', '100'])
    expect(doc.querySelectorAll('.meter-capped')).toHaveLength(1)
  })
  it('shows an official weekly limit even before Sub has a cooldown', () => {
    const now = 1793728000000
    const item = {
      ...relay,
      runtime: {
        ...relay.runtime,
        official_windows: {
          five_hour: { used_percent: 0, resets_at_ms: null },
          seven_day: { used_percent: 100, resets_at_ms: now + 86400000 },
          observed_at_ms: now,
          source_updated_ms: now,
          stale: false,
        },
      },
    }
    expect(relayState(item, now)).toBe('周额度已满')
    expect(scheduleLabel(item, now)).toBe('已开启')
    expect(relayUsageModel(item, now).windows[0].pct).toBe(0)
    expect(relayUsageModel(item, now).stale).toBe(false)
    expect(
      relayState(
        {
          ...item,
          runtime: {
            ...item.runtime,
            official_windows: { ...item.runtime.official_windows, stale: true },
          },
        },
        now
      )
    ).toBe('运行中')
  })
  it('rejects invalid quota amounts without fabricating a valid reading', () => {
    const item = {
      ...relay,
      official_quota: {
        used_usd: 1,
        quota_usd: 0,
        observed_at_ms: 1,
        resets_at_ms: null,
        stale: false,
      },
      usage: {
        last_5h_usd: NaN,
        total_usd: -1,
        unpriced_requests: 0,
        first_at: null,
      },
    }
    const model = relayUsageModel(item, 100)
    expect(model.quota).toBeNull()
    expect(model.rows.every((r) => r.value === undefined)).toBe(true)
  })
  it('does not let an old dollar balance mark fresh percentage windows stale', () => {
    const now = 1800000000000
    const item = {
      ...relay,
      runtime: {
        ...relay.runtime,
        official_windows: {
          five_hour: { used_percent: 28, resets_at_ms: now + 5000 },
          seven_day: { used_percent: 5, resets_at_ms: now + 7000 },
          observed_at_ms: now,
          source_updated_ms: now,
          stale: false,
        },
      },
      official_quota: {
        used_usd: 100,
        quota_usd: 700,
        observed_at_ms: now - 10000000,
        resets_at_ms: null,
        stale: true,
      },
    }
    const model = relayUsageModel(item, now)
    expect(model.windowsStale).toBe(false)
    expect(model.quotaStale).toBe(true)
    expect(model.rows.map((r) => r.label)).toEqual(['近5H', '近7D', '总计'])
    const html = render(true, item)
    expect(html).toContain('官方 · 全员')
    expect(html).toContain('本 Relay')
    expect(html).toContain('滚动统计')
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

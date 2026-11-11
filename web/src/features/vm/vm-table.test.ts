import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { filterVms, sortVms } from './vm-table'

function vm(over: Partial<Vm> = {}): Vm {
  return {
    id: 'vm-01',
    has_token: true,
    has_refresh: true,
    availability: { key: 'ok', usable: true, text: '可用' },
    ...over,
  }
}

describe('filterVms fleet chips', () => {
  const pool = vm({ id: 'pool', schedule_state: 'on', schedulable: true })
  const restricted = vm({
    id: 'restricted',
    schedulable: true,
    schedule_state: 'restricted',
    restriction_reason: 'quota_5h_header',
    availability: {
      key: 'quota',
      usable: true,
      text: '5h 限制',
      reason: 'quota_5h_header',
    },
  })
  const cool = vm({
    id: 'cool',
    schedulable: true,
    schedule_state: 'restricted',
    restriction_reason: 'rate_limited',
    availability: { key: 'cool', usable: true, text: '冷却中' },
  })
  const off = vm({
    id: 'off',
    schedulable: false,
    schedule_state: 'off',
    schedule_manual: true,
    availability: {
      key: 'off',
      usable: false,
      text: '调度关',
      reason: 'disabled',
    },
  })
  const leftover = vm({
    id: 'leftover',
    schedulable: false,
    schedule_disabled_reason: 'quota_7d_safety',
    availability: {
      key: 'off',
      usable: false,
      text: '调度关',
      reason: 'quota_7d_safety',
    },
  })
  const warn = vm({
    id: 'warn',
    schedulable: true,
    schedule_state: 'on',
    near_limit: true,
    utilization_5h: 0.86,
    status_5h: 'allowed_warning',
    availability: undefined,
  })
  const all = [pool, restricted, cool, off, leftover, warn]

  it('keeps 在池 from counting restricted', () => {
    expect(filterVms(all, '', 'pool').map((row) => row.id)).toEqual([
      'pool',
      'warn',
    ])
  })

  it('filters 受限 from cool / quota, including leftover quota-off', () => {
    expect(filterVms(all, '', 'restricted').map((row) => row.id)).toEqual([
      'restricted',
      'cool',
      'leftover',
    ])
  })

  it('keeps 关闭调用 as operator off only', () => {
    expect(filterVms(all, '', 'off').map((row) => row.id)).toEqual(['off'])
  })

  it('selects 无效凭证 and 已吊销 together under the dead zone', () => {
    const bad = vm({
      id: 'bad',
      availability: {
        key: 'bad',
        usable: false,
        text: '无效凭证',
        reason: 'credential_refresh_failed',
      },
      refresh_error: 'invalid_grant',
    })
    const revoked = vm({
      id: 'revoked',
      schedulable: false,
      schedule_disabled_reason: 'oauth_revoked',
      refresh_error: 'oauth_revoked',
      availability: {
        key: 'off',
        usable: false,
        text: '调度关',
        reason: 'oauth_revoked',
      },
    })
    expect(
      filterVms([...all, bad, revoked], '', 'dead').map((row) => row.id)
    ).toEqual(['bad', 'revoked'])
  })

  it('splits Claude and OpenAI slots', () => {
    const claude = vm({ id: 'claude', platform: 'anthropic' })
    const openai = vm({ id: 'openai', platform: 'openai' })
    const rows = [...all, claude, openai]
    expect(filterVms(rows, '', 'all', 'gpt').map((row) => row.id)).toEqual([
      'openai',
    ])
    expect(filterVms(rows, '', 'all', 'claude').map((row) => row.id)).toEqual([
      'pool',
      'restricted',
      'cool',
      'off',
      'leftover',
      'warn',
      'claude',
    ])
  })
})

describe('7D reset order in the slot list', () => {
  it('shows the next valid weekly reset first and keeps stale windows and stopped slots behind', () => {
    const now = Date.parse('2026-11-11T06:00:00Z')
    const running = { status: 'running', schedulable: true } as const
    const rows = [
      vm({
        ...running,
        id: 'late',
        reset_7d: '2026-11-16T18:00:00Z',
        schedule_level: 7,
      }),
      vm({ ...running, id: 'stale', reset_7d: '2026-11-11T06:00:00Z' }),
      vm({ ...running, id: 'near', reset_7d: '1794387600', schedule_level: 1 }),
      vm({ ...running, id: 'unknown', reset_7d_oi: '2026-11-11T06:01:00Z' }),
      vm({
        id: 'stopped',
        status: 'stopped',
        schedulable: false,
        reset_7d: '2026-11-11T06:01:00Z',
      }),
    ]
    expect(
      sortVms(rows, 'reset7d', 'asc', undefined, now).map((row) => row.id)
    ).toEqual(['near', 'late', 'stale', 'unknown', 'stopped'])
  })
})

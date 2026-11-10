import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FableCard } from '@/features/vm/detail-section-primitives'
import { fableRow } from '@/features/vm/usage-meter'
import {
  FABLE_PRO_START,
  FABLE_PRO_END,
} from '../../../src/lib/pool/claude-fable-promotion.mjs'
import {
  fableCardInfo,
  fableProbeLabel,
  fableState,
  fableUsedOf,
  fableWeeklyFull,
  officialFableUsedOf,
} from './fable-status'
import { poolQuota } from './pool-quota'
import { claudeTier } from './vm-status'

const pro = (patch: Partial<Vm> = {}): Vm => ({
  id: 'pro',
  platform: 'anthropic',
  has_token: true,
  has_refresh: true,
  subscription_type: 'pro',
  account_tier: 'pro',
  account_tier_source: 'profile',
  usage_has_fable: true,
  utilization_7d_oi: 0.3,
  reset_7d_oi: '2026-11-17T07:59:00Z',
  ...patch,
})
const unprobed = (patch: Partial<Vm> = {}) =>
  pro({
    usage_has_fable: null,
    utilization_7d_oi: undefined,
    reset_7d_oi: undefined,
    ...patch,
  })

describe('shared Fable details and rack read the same official allowance', () => {
  it('shows the same observed usage on Pro rack, shared state and detail card without changing identity', () => {
    const vm = pro(),
      before = structuredClone(vm)
    expect(officialFableUsedOf(vm)).toBe(0.3)
    expect(fableUsedOf(vm, 'pro')).toBe(0.3)
    expect(fableRow(vm)).toEqual({ kind: 'bar', pct: 30 })
    expect(fableState(vm, 'pro').usedPct).toBe(30)
    expect(fableCardInfo(vm, 'pro', 1, FABLE_PRO_START).usedPct).toBe(30)
    const html = renderToStaticMarkup(
      <FableCard vm={vm} tierKey='pro' dashRouting={undefined} />
    )
    expect(html).toContain('用 30.0%')
    expect(html).not.toContain('Pro 无 Fable')
    expect(claudeTier(vm).key).toBe('pro')
    expect(vm).toEqual(before)
  })

  it('describes promotional eligibility without manufacturing a usage measurement', () => {
    const vm = unprobed()
    expect(fableCardInfo(vm, 'pro', 1, FABLE_PRO_START)).toMatchObject({
      usedPct: null,
      badgeText: 'Fable 5.2 活动 · 未探测',
      badgeCls: 'none',
    })
    expect(fableCardInfo(vm, 'pro', 1, FABLE_PRO_END)).toMatchObject({
      usedPct: null,
      badgeText: '活动未开放',
      badgeCls: 'none',
    })
    expect(fableProbeLabel(vm, 'pro', FABLE_PRO_START - 1)).toBe('活动未开放')
    expect(fableState(vm, 'pro').usedPct).toBeNull()
    expect(fableRow(vm)).toBeNull()
  })

  it.each([NaN, Infinity, -1, undefined])(
    'does not transform invalid canonical usage %s into zero',
    (utilization_7d_oi) => {
      const vm = pro({ utilization_7d_oi })
      expect(officialFableUsedOf(vm)).toBeNull()
      expect(fableUsedOf(vm, 'pro')).toBeNull()
      expect(fableCardInfo(vm, 'pro', 1, FABLE_PRO_START).usedPct).toBeNull()
    }
  )

  it('keeps measured zero distinct from unknown and does not infer usage from a successful model hop', () => {
    expect(fableCardInfo(pro({ utilization_7d_oi: 0 }), 'pro', 1).usedPct).toBe(
      0
    )
    expect(
      fableUsedOf(unprobed({ fable: { ok: true, utilization: 0 } }), 'pro')
    ).toBeNull()
    expect(fableState(unprobed({ fable: { ok: true } }), 'pro').tone.key).toBe(
      'none'
    )
    expect(
      fableProbeLabel(
        unprobed({ fable: { plan_denied: true } }),
        'pro',
        FABLE_PRO_START
      )
    ).toBe('无 Fable 权限')
  })

  it('preserves historical usage after expiry but does not claim current promotional eligibility', () => {
    const detail = fableCardInfo(pro(), 'pro', 1, FABLE_PRO_END)
    expect(detail.usedPct).toBe(30)
    expect(detail.bits).toContain('活动未开放')
    expect(
      fableWeeklyFull(
        unprobed({ status_7d_oi: 'rejected', fable: { limited: true } }),
        'pro'
      )
    ).toBe(false)
  })

  it('does not show tokenless, rejected or Codex records as a measured available allowance', () => {
    for (const vm of [
      pro({ has_token: false }),
      pro({ fable: { banned: true } }),
      pro({ platform: 'openai' }),
    ]) {
      expect(fableUsedOf(vm, 'pro')).toBeNull()
      expect(fableCardInfo(vm, 'pro', 1).usedPct).toBeNull()
      expect(fableState(vm, 'pro').usedPct).toBeNull()
    }
    expect(fableProbeLabel(pro({ has_token: false }), 'pro')).toBe('未授权')
    expect(fableProbeLabel(pro({ fable: { banned: true } }), 'pro')).toBe(
      '账号拒'
    )
  })

  it('keeps valid Max legacy window and explicit probe states while rejecting malformed numbers', () => {
    const max = (patch: Partial<Vm>) =>
      unprobed({ subscription_type: 'max', ...patch })
    expect(fableUsedOf(max({ fable: { utilization: 0.4 } }), 'max')).toBe(0.4)
    expect(
      fableCardInfo(max({ fable: { ok: true } }), 'max', 5).badgeText
    ).toBe('可用')
    expect(
      fableCardInfo(max({ fable: { utilization: 'invalid' } }), 'max', 5)
        .usedPct
    ).toBeNull()
    expect(fableWeeklyFull(max({ fable: { limited: true } }), 'max')).toBe(true)
  })
})

describe('Fable pool display counts only current, measured Pro promotional capacity', () => {
  it('includes the official Pro window only within the native activity period; regular/Codex capacities stay unchanged', () => {
    const codex = pro({ id: 'codex', platform: 'openai' })
    const vms = [pro(), codex, unprobed({ id: 'unprobed' })]
    const active = poolQuota(vms, FABLE_PRO_START).windows
    const expired = poolQuota(vms, FABLE_PRO_END).windows
    expect(active[2]).toMatchObject({ capacity: 1, usedAccounts: 0.3 })
    expect(expired[2].capacity).toBe(0)
    expect(expired[0]).toEqual(active[0])
    expect(expired[1]).toEqual(active[1])
  })
  it('retains Max capacity outside the activity, and excludes explicitly rejected or unknown Pro windows', () => {
    const max = unprobed({ id: 'max', subscription_type: 'max' })
    expect(poolQuota([max], FABLE_PRO_END).windows[2].capacity).toBe(1)
    for (const vm of [
      pro({ fable: { banned: true } }),
      pro({ fable: { plan_denied: true } }),
      unprobed(),
    ]) {
      expect(poolQuota([vm], FABLE_PRO_START).windows[2].capacity).toBe(0)
    }
  })
})

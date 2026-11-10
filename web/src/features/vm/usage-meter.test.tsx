import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { claudeTier } from '@/lib/vm-status'
import { fableRow } from './usage-meter'
import { VmUsageWindows } from './usage-windows'
import { vmWindows } from './vm-rack-model'

const now = Date.parse('2026-11-10T06:00:00Z')
const pro = (patch: Partial<Vm> = {}): Vm => ({
  id: 'pro',
  platform: 'anthropic',
  has_token: true,
  subscription_type: 'pro',
  account_tier: 'pro',
  account_tier_source: 'profile',
  usage_has_fable: true,
  utilization_7d_oi: 0.27,
  reset_7d_oi: '2026-11-17T07:59:00Z',
  ...patch,
})

describe('official Fable allowance is not a subscription label', () => {
  it('shows a Pro promotional window without changing its badge or slot state', () => {
    const vm = pro(),
      before = structuredClone(vm)
    expect(fableRow(vm)).toEqual({ kind: 'bar', pct: 27 })
    expect(vmWindows(vm)[2]).toMatchObject({
      key: 'fable',
      pct: 27,
      reset: vm.reset_7d_oi,
    })
    const html = renderToStaticMarkup(<VmUsageWindows vm={vm} now={now} />)
    expect(html).toContain('Fable 已用')
    expect(html).toContain('27%')
    expect(claudeTier(vm).key).toBe('pro')
    expect(vm).toEqual(before)
  })

  it('uses observed window evidence even when the subscription label is unknown', () => {
    const vm = pro({ subscription_type: null, account_tier: undefined })
    expect(fableRow(vm)).toEqual({ kind: 'bar', pct: 27 })
    expect(claudeTier(vm).key).toBe('none')
  })

  it.each([false, null, undefined])(
    'hides an absent/unconfirmed official window (%s)',
    (usage_has_fable) => {
      expect(fableRow(pro({ usage_has_fable }))).toBeNull()
    }
  )

  it.each([undefined, NaN, Infinity, -1, 101])(
    'does not invent a reading for invalid utilization %s',
    (utilization_7d_oi) => {
      expect(fableRow(pro({ utilization_7d_oi }))).toBeNull()
    }
  )

  it.each([undefined, '', 'invalid'])(
    'requires an actual official reset (%s)',
    (reset_7d_oi) => {
      expect(fableRow(pro({ reset_7d_oi }))).toBeNull()
    }
  )

  it('renders a measured zero while not inferring an allowance from a model probe', () => {
    expect(fableRow(pro({ utilization_7d_oi: 0 }))).toEqual({
      kind: 'bar',
      pct: 0,
    })
    expect(
      fableRow(
        pro({
          usage_has_fable: undefined,
          utilization_7d_oi: undefined,
          fable: { ok: true, utilization: 0.4 },
        })
      )
    ).toBeNull()
  })

  it('preserves the previous measurement after reset and labels it for refresh instead of fabricating zero', () => {
    const vm = pro({ reset_7d_oi: '2026-11-10T05:00:00Z' })
    const html = renderToStaticMarkup(<VmUsageWindows vm={vm} now={now} />)
    expect(fableRow(vm)).toEqual({ kind: 'bar', pct: 27 })
    expect(html).toContain('已过重置')
    expect(html).toContain('27%')
  })

  it('hides tokenless/Codex windows and retains an explicit refusal state', () => {
    expect(fableRow(pro({ has_token: false }))).toBeNull()
    expect(
      fableRow(pro({ platform: 'openai', subscription_type: 'max' }))
    ).toBeNull()
    expect(fableRow(pro({ fable: { banned: true } }))).toEqual({
      kind: 'note',
      text: '拒',
    })
  })

  it('keeps native Max values and existing probe states compatible', () => {
    const max = (patch: Partial<Vm>) =>
      pro({
        subscription_type: 'max',
        usage_has_fable: undefined,
        utilization_7d_oi: undefined,
        reset_7d_oi: undefined,
        ...patch,
      })
    expect(fableRow(max({ utilization_7d_oi: 0.42 }))).toEqual({
      kind: 'bar',
      pct: 42,
    })
    expect(fableRow(max({ fable: { ok: true } }))).toEqual({
      kind: 'note',
      text: '可用',
    })
    expect(fableRow(max({ fable: { banned: true } }))).toEqual({
      kind: 'note',
      text: '拒',
    })
    expect(fableRow(max({}))).toBeNull()
  })
})

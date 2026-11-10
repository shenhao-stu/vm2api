import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { tierVisual } from '@/lib/tier-visual'
import { fableRow } from './usage-meter'

describe('account replacement retains explicit Pro display', () => {
  it('shows promotional Fable usage while preserving the Pro badge', () => {
    const vm: Vm = {
      id: 'hosted-slot',
      has_token: true,
      account_tier: 'pro',
      usage_has_fable: true,
      utilization_7d_oi: 0.21,
      reset_7d_oi: '2026-08-24T00:00:00Z',
      fable: { ok: true },
    }
    expect(tierVisual(vm).label).toBe('Pro')
    expect(fableRow(vm)).toEqual({ kind: 'bar', pct: 21 })
    expect(fableRow({ ...vm, usage_has_fable: false })).toBe(null)
    expect(fableRow({ ...vm, account_tier: 'max' })).toEqual({
      kind: 'bar',
      pct: 21,
    })
  })
})

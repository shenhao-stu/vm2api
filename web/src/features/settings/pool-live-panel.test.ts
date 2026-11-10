import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { predictSeatOrder } from './pool-live-panel'

describe('weekly reset scheduling preview', () => {
  it('reorders at expiry and preserves the existing strategy when switched off', () => {
    const now = Date.parse('2026-11-10T14:00:00Z')
    const vm = (id: string, reset: number, level: number) =>
      ({
        id,
        account_tier: 'pro',
        status: 'running',
        schedulable: true,
        schedule_level: level,
        reset_7d: new Date(reset).toISOString(),
        seats_max: 10,
        seats_used: 0,
      }) as Vm
    const vms = [vm('later', now + 20000, 10), vm('soon', now + 10000, 1)]
    const first = (strategy: string, at: number) =>
      predictSeatOrder(vms, strategy, at)[0].vm.id
    expect(first('weekly-reset', now)).toBe('soon')
    expect(first('weekly-reset', now + 10000)).toBe('later')
    expect(first('balanced', now)).toBe('later')
  })
})

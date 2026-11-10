import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import {
  FABLE_PRO_START,
  FABLE_PRO_END,
  proFablePromotionAllows,
} from '../../../../src/lib/pool/claude-fable-promotion.mjs'
import {
  canSelectModel,
  matchesAllowedModel,
  selectableModels,
  toggleAllowedModel,
} from './allowed-models'

const fable5 = 'claude-fable-5'
const fable51 = 'claude-fable-5-1'
const legacyFable51 = 'claude-fable-5.1'

describe('slot model allowlist compatibility', () => {
  it('checks the canonical model for a saved dotted id', () => {
    expect(matchesAllowedModel(fable51, legacyFable51)).toBe(true)
    expect(matchesAllowedModel(legacyFable51, fable51)).toBe(true)
    expect(matchesAllowedModel(fable51, ' CLAUDE-FABLE-5.1 ')).toBe(true)
  })

  it('keeps Fable 5 and Fable 5.1 independently selectable', () => {
    for (const version51 of [fable51, legacyFable51]) {
      expect(matchesAllowedModel(fable5, version51)).toBe(false)
      expect(matchesAllowedModel(version51, fable5)).toBe(false)
    }
    expect(matchesAllowedModel(fable51, 'claude-fable-5-10')).toBe(false)
    expect(matchesAllowedModel(fable51, 'claude-fable-5-1-20260919')).toBe(true)
    expect(
      matchesAllowedModel('claude-haiku-4-5-20251001', 'claude-haiku-4-5')
    ).toBe(true)
  })

  it('keeps Fable 5.2 separate from 5/5.1, including dated and legacy aliases', () => {
    for (const id of [
      'claude-fable-5-2',
      'claude-fable-5.2',
      'claude-fable-5-2-20261109',
    ]) {
      expect(matchesAllowedModel(id, 'claude-fable-5-2')).toBe(true)
      for (const other of [
        fable5,
        fable51,
        'claude-fable-5-20',
        'claude-fable-5-2-preview',
      ]) {
        expect(matchesAllowedModel(id, other)).toBe(false)
        expect(matchesAllowedModel(other, id)).toBe(false)
      }
    }
    expect(
      toggleAllowedModel(
        ['claude-fable-5.2', 'claude-fable-5-2'],
        'claude-fable-5-2',
        true
      )
    ).toEqual(['claude-fable-5-2'])
  })

  it('unchecks a saved legacy id without removing Fable 5', () => {
    const saved = [legacyFable51, fable5, 'claude-sonnet-5']
    expect(toggleAllowedModel(saved, fable51, false)).toEqual([
      fable5,
      'claude-sonnet-5',
    ])
    expect(saved).toEqual([legacyFable51, fable5, 'claude-sonnet-5'])
  })

  it('saves canonical ids without duplicate legacy entries', () => {
    expect(toggleAllowedModel([legacyFable51, fable51], fable51, true)).toEqual(
      [fable51]
    )
    expect(toggleAllowedModel(['CLAUDE-FABLE-5-1'], fable51, true)).toEqual([
      fable51,
    ])
    expect(toggleAllowedModel([legacyFable51], fable5, true)).toEqual([
      fable51,
      fable5,
    ])
  })

  it('keeps Opus 5 and Opus 5.5 independently selectable', () => {
    expect(matchesAllowedModel('claude-opus-5-5', 'claude-opus-5.5')).toBe(true)
    expect(matchesAllowedModel('claude-opus-5.5', 'claude-opus-5')).toBe(false)
    expect(matchesAllowedModel('claude-opus-5', 'claude-opus-5-5')).toBe(false)
    expect(
      matchesAllowedModel('claude-opus-5-5', 'claude-opus-5-5-20260922')
    ).toBe(true)
    expect(
      toggleAllowedModel(['claude-opus-5.5'], 'claude-opus-5-5', true)
    ).toEqual(['claude-opus-5-5'])
  })
})

describe('model selection shares the native promotion policy', () => {
  const pro = { id: 'pro', has_token: true, subscription_type: 'pro' } as Vm
  it('uses native policy at both endpoints instead of duplicating dates', () => {
    for (const time of [
      FABLE_PRO_START - 1,
      FABLE_PRO_START,
      FABLE_PRO_END - 1,
      FABLE_PRO_END,
      NaN,
    ]) {
      for (const id of [
        'claude-fable-5',
        'claude-fable-5-1',
        'claude-fable-5-2',
        'claude-fable-5.2',
        'claude-fable-5-2-20261109',
      ]) {
        expect(canSelectModel(pro, id, time)).toBe(
          proFablePromotionAllows(id, time)
        )
      }
    }
  })
  it('preserves temporary 5.2 when saving another selection; removes it only after expiry', () => {
    expect(canSelectModel(pro, ' CLAUDE-FABLE-5.2 ', FABLE_PRO_START)).toBe(true)
    const ids = ['claude-sonnet-5-5', fable5, fable51, 'claude-fable-5-2']
    expect(selectableModels(pro, ids, FABLE_PRO_START)).toEqual([
      'claude-sonnet-5-5',
      'claude-fable-5-2',
    ])
    expect(selectableModels(pro, ids, FABLE_PRO_END)).toEqual([
      'claude-sonnet-5-5',
    ])
  })
  it.each(['max', 'max5x', 'max20x', 'ultra'])(
    '%s retains all Fable versions outside the promotion',
    (subscription_type) => {
      for (const id of [fable5, fable51, 'claude-fable-5-2']) {
        expect(
          canSelectModel({ ...pro, subscription_type }, id, FABLE_PRO_END + 1)
        ).toBe(true)
      }
    }
  )
  it('does not use usage to grant unknown/expired credentials; leaves Codex selection unchanged', () => {
    expect(
      canSelectModel(
        {
          ...pro,
          subscription_type: null,
          account_tier: 'max',
          account_tier_source: 'usage',
          usage_has_fable: true,
        },
        'claude-fable-5-2',
        FABLE_PRO_START
      )
    ).toBe(false)
    expect(
      canSelectModel(
        { ...pro, has_token: false },
        'claude-fable-5-2',
        FABLE_PRO_START
      )
    ).toBe(false)
    expect(
      canSelectModel(
        { ...pro, platform: 'openai' },
        'gpt-6.1-sol',
        FABLE_PRO_END
      )
    ).toBe(true)
    expect(canSelectModel(pro, 'claude-sonnet-5-5', FABLE_PRO_END)).toBe(true)
  })
})

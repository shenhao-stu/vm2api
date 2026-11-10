import type { Vm } from '@/types/panel-vm'
import { isCodexVm } from '@/lib/vm-kind'
import { claudeTier } from '@/lib/vm-status'
import { proFablePromotionAllows } from '../../../../src/lib/pool/claude-fable-promotion.mjs'

/** UI affordance only; the gateway independently enforces the same deadline. */
export function canSelectModel(vm: Vm, id: string, now: number): boolean {
  const model = canonicalAllowedModelId(id)
  if (isCodexVm(vm) || !/fable/i.test(model)) return true
  const tier = claudeTier(vm).key
  return tier === 'max' || (tier === 'pro' && proFablePromotionAllows(model, now))
}

export function selectableModels(vm: Vm, ids: string[], now: number): string[] {
  return ids.filter((id) => canSelectModel(vm, id, now))
}

/** Keep saved dotted point releases usable without granting their siblings. */
export function canonicalAllowedModelId(id: string) {
  return String(id)
    .trim()
    .replace(/^claude-fable-5(?:\.|-)([12])(?=-|$)/i, 'claude-fable-5-$1')
    .replace(/^claude-opus-5(?:\.5|-5)(?=-|$)/i, 'claude-opus-5-5')
}

/** Match dated aliases without treating a point release as its parent model. */
export function matchesAllowedModel(modelId: string, entry: string) {
  const model = canonicalAllowedModelId(modelId).toLowerCase()
  const allowed = canonicalAllowedModelId(entry).toLowerCase()
  if (model === allowed) return true
  if (/^claude-fable-/.test(model) || /^claude-fable-/.test(allowed)) {
    const version = (id: string) => id.replace(/-\d{8}$/, '')
    if (version(model) !== version(allowed)) return false
  }
  const opus55 = /^claude-opus-5-5(?:-|$)/
  if (opus55.test(model) !== opus55.test(allowed)) return false
  return model.startsWith(`${allowed}-`) || allowed.startsWith(`${model}-`)
}

export function toggleAllowedModel(
  current: string[],
  id: string,
  checked: boolean
) {
  const target = canonicalAllowedModelId(id)
  const next = [...new Set(current.map(canonicalAllowedModelId))]
  if (checked) return next.includes(target) ? next : [...next, target]
  return next.filter((entry) => entry.toLowerCase() !== target.toLowerCase())
}

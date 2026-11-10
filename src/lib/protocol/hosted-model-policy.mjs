import { resolvePolicyModelId } from './model-policy.mjs'
import { detectInboundPlatform } from './platform-detect.mjs'
import { fablePromotionActive, isFable52 } from './fable-promotion.mjs'

/** Hosted deployment policy, checked before any intercept, health hop or inference. */
export function isFableModel(model, resolve = resolvePolicyModelId) {
  return /fable/i.test(String(model || '')) || /fable/i.test(String(resolve(model) || ''))
}

export function hostedFableDenial(model, now = Date.now()) {
  if (!isFableModel(model)) return null
  const resolved = resolvePolicyModelId(model)
  const rawAllowed = !/fable/i.test(String(model || '')) || isFable52(model)
  if (rawAllowed && isFable52(resolved) && fablePromotionActive(now)) return null
  return {
    code: 'model_disabled',
    message: 'Only Claude Fable 5.2 is temporarily available, until 2026-11-17 08:00 UTC',
  }
}

export function isGatewayOnlyRecord(record) {
  return record?.category === 'hybrid' && record.group_type === 'openai'
}

export function hostedModelDenial(record, model, now = Date.now()) {
  const denial = hostedFableDenial(model, now)
  if (denial) return denial
  const platform = detectInboundPlatform(model).platform
  if (isGatewayOnlyRecord(record) && platform !== 'openai')
    return {
      code: 'key_group_mismatch',
      message: 'This GPT hosted key can only call its configured GPT gateway models',
    }
  if (record?.category === 'oauth' && record.group_type === 'anthropic' && platform === 'openai')
    return { code: 'key_group_mismatch', message: 'This Claude hosted key can only call its authorized Claude slots' }
  return null
}

export function filterHostedModels(catalog, now = Date.now()) {
  return { ...catalog, data: (catalog?.data || []).filter((model) => !hostedFableDenial(model.id, now)) }
}

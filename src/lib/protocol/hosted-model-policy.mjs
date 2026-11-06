import { resolvePolicyModelId } from './model-policy.mjs'
import { detectInboundPlatform } from './platform-detect.mjs'

/** Hosted deployment policy, checked before any intercept, health hop or inference. */
export function isFableModel(model, resolve = resolvePolicyModelId) {
  return /fable/i.test(String(model || '')) || /fable/i.test(String(resolve(model) || ''))
}

export function isGatewayOnlyRecord(record) {
  return record?.category === 'hybrid' && record.group_type === 'openai'
}

export function hostedModelDenial(record, model) {
  if (isFableModel(model))
    return { code: 'model_disabled', message: 'Fable models are disabled on this hosted platform' }
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

export function withoutFableModels(catalog) {
  return { ...catalog, data: (catalog?.data || []).filter((model) => !isFableModel(model.id)) }
}

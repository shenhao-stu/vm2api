import net from 'node:net'
import { detectInboundPlatform } from '../protocol/platform-detect.mjs'
import { slotAllowsModel } from './slot-model-gate.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { parseAllowedVms } from '../admin/key-scope.mjs'
import { isGatewayOnlyRecord, isFableModel } from '../protocol/hosted-model-policy.mjs'

export { isGatewayOnlyRecord }

export function gatewayError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status })
}

export function isHybridKey(req) {
  return req?.apiKeyKind === 'managed' && req.apiKeyRecord?.category === 'hybrid'
}

export function normalizeKeyCategory(value) {
  const category = String(value || '')
    .trim()
    .toLowerCase()
  return category === 'api' || category === 'hybrid' ? category : 'oauth'
}

export function localGatewayOrigin(value) {
  let url
  try {
    url = new URL(String(value || ''))
  } catch {
    throw gatewayError('invalid_local_gateway', 'Local gateway requires a literal loopback HTTP(S) origin')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const loopback = (net.isIP(host) === 4 && host.startsWith('127.')) || host === '::1'
  if (
    !loopback ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw gatewayError('invalid_local_gateway', 'Local gateway requires a literal loopback HTTP(S) origin')
  }
  return url.origin
}

export function assertLocalGatewayEndpoint(endpoint) {
  if (endpoint?.kind !== 'local_gateway') {
    throw gatewayError('local_gateway_required', 'Hybrid keys require a local gateway endpoint', 403)
  }
  localGatewayOrigin(endpoint.base_url)
  const headers = endpoint.headers || {}
  if (
    endpoint.protocol !== 'openai' ||
    Object.keys(headers).some((k) => k !== 'auth_scheme') ||
    (headers.auth_scheme && headers.auth_scheme !== 'authorization_bearer')
  ) {
    throw gatewayError('invalid_local_gateway', 'Local gateways use OpenAI routing without custom headers')
  }
  if ((endpoint.api_key_entries || []).some((key) => key.proxy_url || key.proxy_id)) {
    throw gatewayError('invalid_local_gateway', 'Local gateways cannot use a proxy')
  }
  for (const model of endpoint.models || []) {
    for (const id of [model.name || model.upstream_name, model.alias || model.name || model.upstream_name]) {
      if (
        detectInboundPlatform(id).platform !== 'openai' ||
        isFableModel(id) ||
        /(^|\/)(gpt-image|dall-e)/i.test(String(id))
      ) {
        throw gatewayError('invalid_gateway_model', 'Local gateway models must be explicit GPT chat models')
      }
    }
    if (model.image) throw gatewayError('invalid_gateway_model', 'Image endpoints are not supported by hybrid keys')
  }
  return endpoint
}

export function assertHybridKeyScope(record) {
  if (record.category !== 'hybrid') return
  if (!['anthropic', 'openai'].includes(record.group_type)) {
    throw gatewayError('hybrid_claude_scope_required', 'Hybrid keys must retain a scoped Anthropic slot selection')
  }
  if (isGatewayOnlyRecord(record) && (parseAllowedVms(record.allowed_vms).length || record.vm_pool_id))
    throw gatewayError('gateway_only_scope_required', 'GPT gateway keys cannot bind native slots or VM pools')
  if (!/^ep_[a-f0-9]{12}$/.test(String(record.openai_endpoint_id || ''))) {
    throw gatewayError('hybrid_endpoint_required', 'Select the GPT local gateway for this hybrid key')
  }
}

export function gatewayModels(endpoint) {
  if (!endpoint || endpoint.disabled) return []
  try {
    assertLocalGatewayEndpoint(endpoint)
  } catch {
    return []
  }
  const ids = new Set()
  for (const model of endpoint.models || []) {
    ids.add(model.alias)
    if (endpoint.prefix) ids.add(`${endpoint.prefix}/${model.alias}`)
  }
  return [...ids].map((id) => ({ id, object: 'model', owned_by: endpoint.name || 'local_gateway' }))
}

export function hybridModelCatalog(nativeCatalog, endpoint, { nativeVms = [], record = null } = {}) {
  const native = (nativeCatalog?.data || []).filter(
    (m) =>
      !isGatewayOnlyRecord(record) &&
      !isFableModel(m.id) &&
      detectInboundPlatform(m.id).platform === 'anthropic' &&
      nativeVms.some(
        (vm) =>
          !isCodexVm(vm) &&
          slotAllowsModel({
            vm: { ...vm, policy: { ...vm.policy, allowed_models: vm.policy?.allowed_models ?? vm.allowed_models } },
            model: m.id,
          }).ok,
      ),
  )
  return {
    object: 'list',
    data: [...native, ...gatewayModels(endpoint)],
    source: isGatewayOnlyRecord(record) ? 'local_gateway' : 'hybrid',
  }
}

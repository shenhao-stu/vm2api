import { CLAUDE_OFFICIAL_URL, OPENAI_OFFICIAL_URL, normalizeProtocol, trimBaseUrl } from './api-presets.mjs'
import {
  isCatalogModelId,
  isCodexCatalogModel,
  listGptPublicModels,
  listOfficialModels,
  resolveCatalogModel,
} from '../protocol/models.mjs'
import { isGptSeriesId } from '../protocol/gpt-ids.mjs'

/**
 * CLIProxy-shaped picker: grouped round-robin by endpoint then key.
 * Same alias across endpoints shares a model id; prefix/alias pins an endpoint.
 */
import { isFableModel } from '../protocol/hosted-model-policy.mjs'

function norm(s) {
  return String(s || '').trim()
}

function lower(s) {
  return norm(s).toLowerCase()
}

function isOfficialClaude(ep) {
  if (!ep) return false
  if (ep.kind === 'claude') return true
  const u = trimBaseUrl(ep.base_url)
  return u === CLAUDE_OFFICIAL_URL
}

function isOfficialOpenAI(ep) {
  if (!ep) return false
  if (ep.kind === 'openai') return true
  const u = trimBaseUrl(ep.base_url)
  return u === OPENAI_OFFICIAL_URL
}

export function stripPrefix(model, prefix) {
  const p = norm(prefix)
  if (!p) return norm(model)
  const needle = p + '/'
  const raw = norm(model)
  if (raw.toLowerCase().startsWith(needle.toLowerCase())) return raw.slice(needle.length)
  return raw
}

export function modelIdsForEndpoint(ep, { forcePrefix = false } = {}) {
  const prefix = norm(ep.prefix)
  const ids = []
  const seen = new Set()
  const keyOf = ep.kind === 'local_gateway' ? norm : lower
  const add = (alias) => {
    if (!alias || isFableModel(alias)) return
    const names = [...(!forcePrefix || !prefix ? [alias] : []), ...(prefix ? [prefix + '/' + alias] : [])]
    for (const name of names)
      if (!seen.has(keyOf(name))) {
        seen.add(keyOf(name))
        ids.push(name)
      }
  }
  for (const m of ep.models || []) {
    if (!isFableModel(m.name || m.upstream_name)) add(norm(m.alias))
  }
  if (isOfficialClaude(ep) || isOfficialOpenAI(ep)) {
    for (const m of isOfficialClaude(ep) ? listOfficialModels() : listGptPublicModels()) {
      if (!(ep.models || []).some((row) => lower(row.alias) === lower(m.id))) add(m.id)
    }
  }
  return ids
}

export function resolveUpstreamPool(ep, requestedModel) {
  const want = lower(stripPrefix(requestedModel, ep.prefix))
  if (!want) return []
  const out = []
  const seen = new Set()
  for (const m of ep.models || []) {
    if (lower(m.alias) !== want) continue
    const name = norm(m.name) || norm(m.upstream_name) || norm(m.alias)
    if (isFableModel(name) || isFableModel(m.alias)) continue
    const key = lower(name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  if (out.length || (ep.models || []).some((m) => lower(m.alias) === want)) return out
  const raw = stripPrefix(requestedModel, ep.prefix)
  if (isFableModel(raw)) return []
  if (isOfficialClaude(ep)) {
    const resolved = resolveCatalogModel(raw)
    if (resolved?.ok && resolved.model && !isFableModel(resolved.model)) return [resolved.model]
    if (isCatalogModelId(raw) && !isCodexCatalogModel(raw)) return [raw]
  }
  if (isOfficialOpenAI(ep) && listGptPublicModels().some((m) => lower(m.id) === want)) return [raw]
  return []
}

export function endpointMatchesModel(ep, requestedModel) {
  if (!ep || ep.disabled) return false
  const raw = norm(requestedModel)
  const prefix = norm(ep.prefix)
  if (prefix && raw.toLowerCase().startsWith((prefix + '/').toLowerCase())) {
    return resolveUpstreamPool(ep, raw).length > 0
  }
  return resolveUpstreamPool(ep, raw).length > 0
}

function matchesGroup(ep, group) {
  return group === 'all' || normalizeProtocol(ep.protocol, ep.kind) === group
}

function keyReady(key, now, disableCooling) {
  if (!key || key.disabled) return false
  if (disableCooling) return true
  if (!key.cooldown_until) return true
  return Date.parse(key.cooldown_until) <= now
}

export class ApiScheduler {
  constructor() {
    this.endpoints = []
    this.parentCursor = 0
    this.childCursor = new Map()
    this.modelCursor = new Map()
    this.forcePrefix = false
  }

  reload(endpoints = []) {
    this.endpoints = Array.isArray(endpoints) ? endpoints : []
  }

  catalog({ groupType = 'all' } = {}) {
    const data = []
    const seen = new Set()
    for (const ep of this.endpoints) {
      if (ep.disabled || ep.kind === 'local_gateway' || !matchesGroup(ep, groupType)) continue
      for (const id of modelIdsForEndpoint(ep, { forcePrefix: this.forcePrefix })) {
        const k = lower(id)
        if (seen.has(k)) continue
        seen.add(k)
        data.push({
          id,
          object: 'model',
          type: 'model',
          display_name: id,
          owned_by: ep.name || 'api',
        })
      }
    }
    return { object: 'list', data, source: 'api-endpoints' }
  }

  pick(requestedModel, now = Date.now(), { localGatewayId = null, groupType = 'all' } = {}) {
    if (isFableModel(requestedModel))
      return { ok: false, code: 'model_disabled', message: 'Fable models are disabled on this hosted platform' }
    const parents = this.endpoints
      .filter((ep) => matchesGroup(ep, groupType))
      .filter((ep) =>
        localGatewayId ? ep.id === localGatewayId && ep.kind === 'local_gateway' : ep.kind !== 'local_gateway',
      )
      .filter((ep) =>
        localGatewayId
          ? !ep.disabled && modelIdsForEndpoint(ep).includes(requestedModel)
          : endpointMatchesModel(ep, requestedModel),
      )
      .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0))
    if (!parents.length) {
      return { ok: false, code: 'model_not_found', message: `no api endpoint serves ${requestedModel}` }
    }
    const start = this.parentCursor % parents.length
    for (let off = 0; off < parents.length; off++) {
      const ep = parents[(start + off) % parents.length]
      const keys = (ep.api_key_entries || []).filter((k) => keyReady(k, now, ep.disable_cooling))
      if (!keys.length) continue
      const c = this.childCursor.get(ep.id) || 0
      const key = keys[c % keys.length]
      this.childCursor.set(ep.id, c + 1)
      this.parentCursor = start + off + 1
      const pool = localGatewayId
        ? (ep.models || [])
            .filter((m) => requestedModel === m.alias || (ep.prefix && requestedModel === `${ep.prefix}/${m.alias}`))
            .map((m) => m.name || m.upstream_name)
        : resolveUpstreamPool(ep, requestedModel)
      const mk = `${ep.id}:${lower(requestedModel)}`
      const mi = this.modelCursor.get(mk) || 0
      const upstreamModel = pool[mi % pool.length] || requestedModel
      this.modelCursor.set(mk, mi + 1)
      return {
        ok: true,
        endpoint: ep,
        key,
        upstream_model: upstreamModel,
        requested_model: requestedModel,
      }
    }
    return { ok: false, code: 'api_pool_exhausted', message: 'no ready api key for this model' }
  }
}

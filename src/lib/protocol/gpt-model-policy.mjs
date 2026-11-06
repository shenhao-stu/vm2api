/**
 * GPT catalog. Separate settings key from Claude model_policy.
 * Live ids from ChatGPT sync; seed is empty-catalog fallback.
 */
import { getDb, isDbOpen } from '../db/database.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { isGptSeriesId, isSyncableGptCatalogId } from './gpt-ids.mjs'
import { IMAGE_TOOL_MODELS, canonicalImageToolModel } from './image-tool-models.mjs'

const SETTINGS_KEY = 'gpt_model_policy'
// Separate containers/processes write the same SQLite row: a short read-through
// window keeps one process from serving a stale draft for long.
const POLICY_CACHE_TTL_MS = 5_000

const CAP_GPT = {
  context_window: 272000,
  supports_1m: false,
  thinking_mode: 'enabled_only',
  supports_adaptive: false,
  requires_adaptive: false,
  supports_interleaved: false,
  supports_effort: false,
  supports_context_management: false,
}

function entry(id, extra = {}) {
  return {
    id,
    display_name: extra.display_name || extra.label || id,
    family: 'codex',
    enabled: extra.enabled !== false,
    sort: extra.sort || 80,
    capabilities: extra.capabilities || { ...CAP_GPT },
    params: extra.params || { max_tokens_default: 16384, max_tokens_cap: 128000 },
    aliases: extra.aliases || [],
    expose_fast: extra.expose_fast === true,
  }
}

function bareModelId(model) {
  const raw = String(model || '').trim()
  if (!raw) return ''
  return raw.split('/').filter(Boolean).pop() || raw
}

function exactPolicyModelId(id) {
  const lower = String(id || '')
    .trim()
    .toLowerCase()
  if (!lower) return null
  return Object.keys(policy.models || {}).find((candidate) => candidate.toLowerCase() === lower) || null
}

function hasPriorityTier(row) {
  return (
    Array.isArray(row?.catalog?.service_tiers) &&
    row.catalog.service_tiers.some((tier) => tier && typeof tier === 'object' && tier.id === 'priority')
  )
}

/** Resolve the generated `<model>-fast` alias without treating it as a catalog id. */
export function resolveGptFastAlias(model) {
  if (!cacheFresh()) loadGptModelPolicy()
  const alias = bareModelId(model)
  if (!/^gpt-/i.test(alias) || !/-fast$/i.test(alias)) return { kind: 'normal', model: alias }

  const actualId = exactPolicyModelId(alias)
  if (actualId) return { kind: 'actual', model: actualId }

  const baseId = alias.replace(/-fast$/i, '')
  const baseIdExact = exactPolicyModelId(baseId)
  const base = baseIdExact ? policy.models?.[baseIdExact] : null
  if (!baseIdExact || !base) {
    return { kind: 'unavailable', alias, reason: 'base_missing' }
  }
  if (base.enabled === false) return { kind: 'unavailable', alias, reason: 'base_disabled', base: baseIdExact }
  if (base.expose_fast !== true) return { kind: 'unavailable', alias, reason: 'not_exposed', base: baseIdExact }
  if (!hasPriorityTier(base)) return { kind: 'unavailable', alias, reason: 'priority_missing', base: baseIdExact }
  return { kind: 'fast', alias, base: baseIdExact, service_tier: 'priority' }
}

export function isGptFastAliasAvailable(model) {
  return resolveGptFastAlias(model).kind === 'fast'
}

export function listGptFastAliases({ mappingKeys = [] } = {}) {
  if (!cacheFresh()) loadGptModelPolicy()
  const actualIds = new Set(Object.keys(policy.models || {}).map((id) => id.toLowerCase()))
  const mapped = new Set(
    (Array.isArray(mappingKeys) ? mappingKeys : []).map((id) => bareModelId(id).toLowerCase()).filter(Boolean),
  )
  return Object.entries(policy.models || {})
    .filter(([id, row]) => {
      const alias = `${id}-fast`.toLowerCase()
      return (
        /^gpt-/i.test(id) &&
        row?.enabled !== false &&
        row?.expose_fast === true &&
        hasPriorityTier(row) &&
        !actualIds.has(alias) &&
        !mapped.has(alias)
      )
    })
    .map(([id, row]) => ({
      id: `${id}-fast`,
      display_name: `${row.display_name || id} Fast`,
      family: 'codex',
      enabled: true,
      source: 'gpt-model-policy',
      alias_of: id,
      service_tier: 'priority',
    }))
}

/** Known image model ids only; `enabled` must be a boolean. Unlisted ids keep `base`. */
/** Known image model ids only; `enabled` must be a boolean. Unlisted ids keep `base`. */
function normalizeImageTools(raw, base = null) {
  const out = {}
  for (const model of IMAGE_TOOL_MODELS) {
    out[model.id] = { enabled: base?.[model.id]?.enabled !== false }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, row] of Object.entries(raw)) {
    const canonical = canonicalImageToolModel(id)
    if (canonical && typeof row?.enabled === 'boolean') out[canonical] = { enabled: row.enabled }
  }
  return out
}

export function seedGptPolicy() {
  const models = {}
  for (const [id, extra] of [
    ['gpt-6-sol', { display_name: 'GPT-6 Sol', sort: 70 }],
    ['gpt-6-luna', { display_name: 'GPT-6 Luna', sort: 71 }],
    ['gpt-5.6', { display_name: 'GPT-5.6', sort: 76 }],
    ['gpt-5.5', { display_name: 'GPT-5.5', sort: 77 }],
    ['gpt-5.4', { display_name: 'GPT-5.4', sort: 80, aliases: ['codex'] }],
    ['gpt-5.4-mini', { display_name: 'GPT-5.4 Mini', sort: 81 }],
    ['gpt-5.3-codex', { display_name: 'GPT-5.3 Codex', sort: 82 }],
  ]) {
    models[id] = entry(id, extra)
  }
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    source: 'seed',
    platform: 'openai',
    models,
    image_tools: normalizeImageTools(null),
  }
}

let policy = seedGptPolicy()
let loaded = false
let loadedAt = 0

function cacheFresh() {
  const age = Date.now() - loadedAt
  return loaded && age >= 0 && age < POLICY_CACHE_TTL_MS
}

/** A nonempty persisted catalog is authoritative, including legacy panel saves. */
function hasCatalogRows(stored) {
  return !!stored && !!Object.keys(stored.models || {}).length
}

function hydratePolicy(stored) {
  const seed = seedGptPolicy()
  const next = hasCatalogRows(stored)
    ? { ...stored, models: { ...stored.models } }
    : { ...seed, ...stored, models: { ...seed.models, ...stored.models } }
  next.platform = 'openai'
  next.source = next.source || 'settings'
  next.image_tools = normalizeImageTools(stored.image_tools)
  return next
}

/** Settings live in SQLite; without an opened DB the module only keeps in-memory state. */
function persistPolicy(target) {
  if (!isDbOpen()) return false
  new SettingsRepo().set(SETTINGS_KEY, target)
  return true
}

/** Run a read-merge-write under the DB write lock so another container cannot interleave. */
function withPolicyWrite(fn) {
  if (!isDbOpen()) return fn()
  const db = getDb()
  if (db.isTransaction) return fn()
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    loaded = false
    loadedAt = 0
    throw e
  }
}

function adoptPolicy(next) {
  policy = next
  loaded = true
  loadedAt = Date.now()
  return policy
}

/** Latest persisted policy (bypassing the read cache); in-memory state without a DB. */
function readLatestPolicy() {
  if (!isDbOpen()) {
    if (!loaded) adoptPolicy(seedGptPolicy())
    return policy
  }
  const stored = new SettingsRepo().get(SETTINGS_KEY, null)
  if (stored && typeof stored === 'object' && stored.models && typeof stored.models === 'object') {
    return adoptPolicy(hydratePolicy(stored))
  }
  return adoptPolicy(seedGptPolicy())
}

export function loadGptModelPolicy({ force = false } = {}) {
  if (!force && cacheFresh()) return policy
  if (!isDbOpen()) {
    if (force || !loaded) return adoptPolicy(seedGptPolicy())
    loadedAt = Date.now()
    return policy
  }
  try {
    readLatestPolicy()
  } catch {
    if (!loaded) adoptPolicy(seedGptPolicy())
    loadedAt = Date.now()
  }
  return policy
}

export function getGptModelPolicy() {
  if (!cacheFresh()) loadGptModelPolicy()
  return policy
}

function sameIdKey(models, id) {
  if (models[id]) return id
  const lower = String(id).toLowerCase()
  return Object.keys(models).find((key) => key.toLowerCase() === lower) || id
}

/**
 * Merge a panel save into the latest persisted catalog. A stale draft only
 * carries admin edits: it can neither delete discovered rows nor rewrite
 * upstream catalog facts.
 */
export function saveGptModelPolicy(next) {
  const submitted = next && typeof next === 'object' ? next : {}
  return withPolicyWrite(() => {
    const current = readLatestPolicy()
    const seed = seedGptPolicy()
    // Seed rows are only an empty-catalog fallback. Legacy saves use source
    // 'panel', so source alone must never repopulate unrelated seed models.
    const models = hasCatalogRows(current) ? { ...current.models } : { ...seed.models, ...current.models }
    if (submitted.models && typeof submitted.models === 'object') {
      for (const [rawId, row] of Object.entries(submitted.models)) {
        const id = String(rawId || '').trim()
        if (!isGptSeriesId(id) || !row || typeof row !== 'object') continue
        // Catalog facts come from the upstream sync only; a stale panel draft must not overwrite them.
        const { catalog: _drop, ...edits } = row
        const key = sameIdKey(models, id)
        const base = models[key] || entry(id)
        const merged = {
          ...base,
          ...edits,
          id,
          family: 'codex',
          expose_fast: typeof edits.expose_fast === 'boolean' ? edits.expose_fast : base.expose_fast === true,
        }
        const catalog = current.models?.[key]?.catalog
        if (catalog) merged.catalog = catalog
        else delete merged.catalog
        models[key] = merged
      }
    }
    const live = current.source === 'codex'
    const nextPolicy = {
      ...current,
      ...submitted,
      models,
      image_tools: normalizeImageTools(submitted.image_tools, current.image_tools),
      platform: 'openai',
      updated_at: new Date().toISOString(),
      source: live ? 'codex' : 'panel',
    }
    persistPolicy(nextPolicy)
    return adoptPolicy(nextPolicy)
  })
}
export function listGptPolicyModels() {
  if (!cacheFresh()) loadGptModelPolicy()
  return Object.entries(policy.models || {})
    .filter(([id, cfg]) => isGptSeriesId(id) && cfg?.enabled !== false)
    .map(([id, cfg]) => ({ id, ...cfg, family: 'codex' }))
    .sort((a, b) => (a.sort || 80) - (b.sort || 80) || String(a.id).localeCompare(String(b.id)))
}

export function getGptPolicyCatalogIds({ enabledOnly = false } = {}) {
  if (!cacheFresh()) loadGptModelPolicy()
  return Object.entries(policy.models || {})
    .filter(([id, cfg]) => isGptSeriesId(id) && (!enabledOnly || cfg?.enabled !== false))
    .map(([id]) => id)
}

export function isGptModelEnabled(id) {
  if (!isGptSeriesId(id)) return false
  if (!cacheFresh()) loadGptModelPolicy()
  const row = policy.models?.[id]
  if (row) return row.enabled !== false
  if (policy.source === 'codex' && Object.keys(policy.models || {}).length) return false
  return true
}

/** false = known and disabled; null = not a gateway image model (the upstream decides). */
export function isImageToolModelEnabled(id) {
  const canonical = canonicalImageToolModel(id)
  if (!canonical) return null
  if (!cacheFresh()) loadGptModelPolicy()
  return policy.image_tools?.[canonical]?.enabled !== false
}

export function listImageToolModels() {
  if (!cacheFresh()) loadGptModelPolicy()
  return IMAGE_TOOL_MODELS.map((model) => ({
    id: model.id,
    display_name: model.display_name,
    snapshots: [...model.snapshots],
    upstream_default: model.upstream_default,
    sort: model.sort,
    enabled: policy.image_tools?.[model.id]?.enabled !== false,
  }))
}

export function resetGptModelPolicy() {
  return withPolicyWrite(() => {
    const next = seedGptPolicy()
    persistPolicy(next)
    return adoptPolicy(next)
  })
}

/**
 * Add the live Codex sample to the known catalog. Samples differ by account, so
 * an omitted row never deletes an existing model or an administrator's edits.
 * New rows stay disabled until reviewed by an administrator.
 */
export function syncGptIdsIntoPolicy(ids = [], { displayNameOf = null } = {}) {
  const live = []
  const seen = new Set()
  for (const item of Array.isArray(ids) ? ids : []) {
    const id = String(typeof item === 'string' ? item : item?.id || '').trim()
    if (!isSyncableGptCatalogId(id) || seen.has(id.toLowerCase())) continue
    seen.add(id.toLowerCase())
    live.push({
      id,
      display_name: String((typeof item === 'object' && item?.display_name) || '').trim(),
      catalog: typeof item === 'object' && item?.catalog && typeof item.catalog === 'object' ? item.catalog : null,
    })
  }
  if (!live.length) {
    return { ok: true, synced: 0, added: [], ids: listGptPolicyModels().map((m) => m.id) }
  }
  return withPolicyWrite(() => {
    const current = readLatestPolicy()
    const models = { ...current.models }
    const added = []
    const syncedAt = new Date().toISOString()
    for (const row of live) {
      const key = sameIdKey(models, row.id)
      const prev = models[key]
      if (!prev) added.push(row.id)
      models[key] = {
        ...prev,
        ...entry(key, {
          ...prev,
          display_name: prev?.display_name || row.display_name || displayNameOf?.(row.id) || row.id,
          enabled: prev ? prev.enabled !== false : false,
        }),
      }
      // Only an upstream sync can replace catalog facts. Missing metadata keeps
      // the last known facts; a narrower account sample never erases a model.
      const catalog = row.catalog ? { ...row.catalog, synced_at: syncedAt } : prev?.catalog
      if (catalog) models[key].catalog = catalog
    }
    const next = {
      ...current,
      models,
      platform: 'openai',
      updated_at: syncedAt,
      source: 'codex',
    }
    persistPolicy(next)
    adoptPolicy(next)
    return {
      ok: true,
      synced: live.length,
      added,
      ids: listGptPolicyModels().map((m) => m.id),
    }
  })
}

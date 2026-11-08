// Observation and configuration are different facts. Only a literal boolean is an observation.
const bounded = (value) =>
  ['string', 'number', 'boolean'].includes(typeof value) ? String(value).trim().slice(0, 200) || null : null

const configurationHeaders = new Map([
  ['x-codex-safety-buffering-enabled', 'safety_buffering_enabled'],
  ['x-codex-safety-buffering-faster-model', 'safety_buffering_faster_model'],
])

export function observeCodexSafety(previous = {}, value = {}) {
  const next = { ...previous }
  for (const source of [value, value?.response]) {
    if (!source || typeof source !== 'object') continue
    if (source.safety_buffering === true) next.safety_buffering = true
    else if (source.safety_buffering === false && next.safety_buffering !== true) next.safety_buffering = false
    for (const key of ['safety_buffering_enabled', 'safety_buffering_faster_model']) {
      const item = bounded(source[key])
      if (item != null) next[key] = item
    }
  }
  if (value?.type === 'codex.response.metadata') {
    for (const [key, raw] of Object.entries(value.headers || {})) {
      const field = configurationHeaders.get(key.trim().toLowerCase())
      const item = bounded(raw)
      if (field && item != null) next[field] = item
    }
  }
  return next
}

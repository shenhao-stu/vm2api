/** Keep existing allowlists usable after correcting dotted 5.1 / 5.5 ids. */
export function canonicalAllowedModelId(id: string) {
  return String(id)
    .trim()
    .replace(/^claude-fable-5(?:\.2|-2)(?=-|$)/i, 'claude-fable-5-2')
    .replace(/^claude-fable-5(?:\.1|-1)(?=-|$)/i, 'claude-fable-5-1')
    .replace(/^claude-opus-5(?:\.5|-5)(?=-|$)/i, 'claude-opus-5-5')
}

/** Match dated aliases without treating a point release as its parent model. */
export function matchesAllowedModel(modelId: string, entry: string) {
  const model = canonicalAllowedModelId(modelId).toLowerCase()
  const allowed = canonicalAllowedModelId(entry).toLowerCase()
  if (model === allowed) return true
  const fable52 = /^claude-fable-5-2(?:-|$)/
  if (fable52.test(model) !== fable52.test(allowed)) return false
  const fable51 = /^claude-fable-5-1(?:-|$)/
  if (fable51.test(model) !== fable51.test(allowed)) return false
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

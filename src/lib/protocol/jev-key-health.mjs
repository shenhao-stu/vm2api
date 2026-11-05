import { createHash } from 'node:crypto'

export const JEV_KEY_HEALTH_SETTING = 'jev_key_health'
const REASONS = new Set(['invalid_credentials', 'organization_disabled'])
const scopeId = (target) => createHash('sha256').update(target).digest('hex')

/** Persist only endpoint-scoped fingerprints and bounded reasons, never keys or response text. */
export function createJevKeyHealth(settings = null) {
  const stored = settings?.get(JEV_KEY_HEALTH_SETTING, {}) || {}
  const retired = new Map(
    Object.entries(stored).filter(([id, reason]) => /^[a-f0-9]{64}$/.test(id) && REASONS.has(reason)),
  )
  const save = () => settings?.set(JEV_KEY_HEALTH_SETTING, Object.fromEntries(retired))
  return {
    reason: (target) => retired.get(scopeId(target)) || null,
    retire(target, reason) {
      if (!REASONS.has(reason) || retired.get(scopeId(target)) === reason) return
      retired.set(scopeId(target), reason)
      save()
    },
    rearm(targets) {
      let changed = false
      for (const target of targets) changed = retired.delete(scopeId(target)) || changed
      if (changed) save()
    },
  }
}

/** A generic 403 may be a WAF or endpoint restriction, not credential death. */
export function jevCredentialFailure(status, payload) {
  if (status === 401) return 'invalid_credentials'
  const error = payload?.detail || payload?.error
  if (status !== 403 || (error?.error_type || error?.type) !== 'authentication_error') return null
  return /\b(?:organization|account)\b.{0,80}\b(?:deactivated|disabled|suspended)\b/i.test(error?.message || '')
    ? 'organization_disabled'
    : null
}

/** Error bodies have no usage; consume at most 8 KiB and release the response. */
export async function readJevCredentialFailure(response) {
  const reader = response.body?.getReader?.()
  let payload
  try {
    if (response.status === 403 && reader) {
      const chunks = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 8192) return null
        chunks.push(Buffer.from(value))
      }
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        /* non-JSON error */
      }
    }
    return jevCredentialFailure(Number(response.status), payload)
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

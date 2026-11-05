const AUTH_CODES = new Set([
  'authentication_error',
  'upstream_auth',
  'upstream_auth_error',
  'oauth_401',
  'oauth_revoked',
  'token_revoked',
  'token_invalidated',
  'invalid_api_key',
  'invalid_token',
  'token_expired',
  'invalid_grant',
])
const REVOKED_CODES = new Set(['oauth_revoked', 'token_revoked', 'token_invalidated', 'invalid_grant'])
const REVOKED_TEXT =
  /\b(?:oauth_revoked|token_revoked|token_invalidated|invalid_grant)\b|\b(?:(?:oauth|access|authentication|bearer)\s+)*token\s+(?:(?:has\s+been|was|is)\s+)?(?:revoked|invalidated)\b/i
const AUTH_ERROR_TEXT =
  /\binvalid (?:bearer|x-api-key)\b|\b(?:oauth\s+)?(?:(?:access|authentication|bearer)\s+)?token\s+(?:has\s+)?expired\b/i
const PERMISSION_ERROR_TEXT = /organization does not have access to claude/i

/** Extract only a provider wrapper's JSON object, allowing diagnostic suffixes. */
function wrappedErrorBody(message) {
  const text = message.slice(0, 16_384)
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

/** A busy-credential verdict must be a parsed upstream code inside a kernel wrapper. */
export function foldedNoCapacityError(errorBody) {
  if (errorBody?.error?.code !== 'provider_error') return null
  const inner = wrappedErrorBody(String(errorBody.error.message || ''))?.error
  return inner && typeof inner === 'object' && inner.code === 'no_capacity' ? inner : null
}

/** Auth evidence from a trusted upstream error body, never from bare HTTP numbers. */
export function upstreamAuthFailureReason(errorBody, depth = 0) {
  if (!errorBody || typeof errorBody !== 'object' || depth > 3) return null
  const error = errorBody.error && typeof errorBody.error === 'object' ? errorBody.error : errorBody
  const code = String(error.code || '').toLowerCase()
  const type = String(error.type || '').toLowerCase()
  const message = String(error.message || '')
  const revoked = REVOKED_CODES.has(code) || REVOKED_CODES.has(type) || REVOKED_TEXT.test(message)
  if (AUTH_CODES.has(code) || AUTH_CODES.has(type) || revoked || AUTH_ERROR_TEXT.test(message)) {
    return revoked ? 'oauth_revoked' : 'credential_blocked'
  }
  const providerWrapper =
    code === 'provider_error' ||
    (['worker_error', 'api_error', 'upstream_error'].includes(type) && /^(?:provider|upstream) error:/i.test(message))
  return providerWrapper ? upstreamAuthFailureReason(wrappedErrorBody(message), depth + 1) : null
}

export function restoreCodexErrorStatus(result) {
  if (!result || result.ok || result.committed || result.transportError) return result
  const status = Number(result.status)
  if (![200, 401, 502].includes(status)) return result
  const body = result.body
  const busy = foldedNoCapacityError(body)
  if (busy) return { ...result, status: 503, terminalState: 'rejected', body: { ...body, error: { ...busy } } }
  if (upstreamAuthFailureReason(body)) return { ...result, status: 401, terminalState: 'rejected' }
  if (body?.error?.code === 'server_is_overloaded') return { ...result, status: 503, terminalState: 'rejected' }
  return result
}

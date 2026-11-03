import { safeTiming } from '../transport/stream-timing.mjs'
const finite = (value) => (Number.isFinite(value) && value >= 0 ? value : null)
// Bounded metadata only: never persist arbitrary error messages, URLs or credentials.
export function attemptDiagnostic(attemptNo, result = {}, policy = {}) {
  const error = result?.body?.error || result?.error || {}
  const hay = `${error.code || ''} ${error.message || ''}`
  const network =
    /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ERR_TLS_CERT_ALTNAME_INVALID/i
      .exec(hay)?.[0]
      ?.toUpperCase() || null
  return {
    attempt: finite(attemptNo),
    timing: safeTiming(result?.timing),
    upstream_status: finite(result?.status),
    content_committed: result?.committed === true,
    upstream_executions:
      Number.isInteger(result?.upstreamExecutions) && result.upstreamExecutions >= 0 ? result.upstreamExecutions : null,
    replay_blocked: policy?.replayAllowed === false,
    first_token_ms: finite(result?.ttftMs),
    network_code: network,
    failure_stage:
      network === 'ENOTFOUND' || network === 'EAI_AGAIN'
        ? 'dns'
        : network === 'ECONNREFUSED'
          ? 'connect'
          : network === 'ERR_TLS_CERT_ALTNAME_INVALID'
            ? 'tls'
            : /connection error/i.test(hay)
              ? 'upstream_connection_unspecified'
              : 'unknown',
    transport_failure: policy?.reason === 'proxy_transport_failure',
  }
}

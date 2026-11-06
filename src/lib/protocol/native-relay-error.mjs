/** Retain the native scheduling contract without exposing upstream debug data. */
export function safeNativeRelayError(status, error, model) {
  const code = error?.code
  const consumed = status === 400 && code === 'native_request_consumed_no_replay'
  if (!consumed && !(status === 429 && code === 'native_rate_limit')) return null

  const details = consumed ? { no_replay: true } : {}
  const quota = error?.details
  if (consumed && quota?.upstream_type === 'gateway_error' && [502, 503, 504].includes(quota.upstream_status)) {
    return {
      type: 'api_error', code,
      message: `ReClaude gateway returned HTTP ${quota.upstream_status}. This request was dispatched once. To continue with new input and the same local history, use claude --resume <session-id> --fork-session.`,
      details: { ...details, upstream_type: 'gateway_error', upstream_status: quota.upstream_status },
    }
  }
  if (
    quota?.upstream_type === 'rate_limit_error' &&
    quota.model === model &&
    typeof model === 'string' &&
    /^[a-z0-9._-]{1,128}$/i.test(model)
  ) {
    details.upstream_type = 'rate_limit_error'
    details.model = model
    if (typeof quota.rate_limit_type === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(quota.rate_limit_type)) {
      details.rate_limit_type = quota.rate_limit_type
    }
    if (Number.isSafeInteger(quota.reset_at) && quota.reset_at > 0 && quota.reset_at <= 253402300799) {
      details.reset_at = quota.reset_at
    }
  }
  return { type: 'api_error', code, message: code, ...(Object.keys(details).length ? { details } : {}) }
}

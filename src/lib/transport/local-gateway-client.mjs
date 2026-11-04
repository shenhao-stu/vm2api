import http from 'node:http'
import https from 'node:https'
import { assertLocalGatewayEndpoint, gatewayError, localGatewayOrigin } from '../pool/local-gateway-policy.mjs'

const PATHS = Object.freeze({
  'openai.responses': '/v1/responses',
  'openai.chat': '/v1/chat/completions',
  'openai.completions': '/v1/completions',
  'anthropic.messages': '/v1/messages',
})
const CALLER_HEADERS = [
  'user-agent',
  'anthropic-version',
  'anthropic-beta',
  'originator',
  'openai-beta',
  'session-id',
  'thread-id',
  'x-client-request-id',
  'x-codex-beta-features',
  'x-codex-parent-thread-id',
  'x-codex-turn-metadata',
  'x-codex-turn-state',
]

/** Separate trust boundary from arbitrary API providers: only a typed, literal loopback gateway. */
export function forwardLocalGateway({
  endpoint,
  key,
  protocol,
  body,
  callerHeaders = {},
  signal,
  timeoutMs = 120_000,
  onDispatched = () => {},
} = {}) {
  assertLocalGatewayEndpoint(endpoint)
  if (Number.isFinite(timeoutMs) && timeoutMs <= 0)
    throw gatewayError('gateway_timeout', 'Local gateway deadline expired', 504)
  const route = PATHS[protocol]
  if (!route) throw gatewayError('gateway_protocol_unsupported', 'This protocol is not supported by the local gateway')
  if (
    !key?.api_key ||
    !endpoint.api_key_entries?.some((k) => k.id === key.id && k.api_key === key.api_key && !k.disabled)
  ) {
    throw gatewayError('gateway_key_unavailable', 'The selected gateway credential is unavailable', 503)
  }
  const url = new URL(route, localGatewayOrigin(endpoint.base_url))
  const payload = Buffer.from(JSON.stringify(body))
  const headers = { 'content-type': 'application/json', accept: body.stream ? 'text/event-stream' : 'application/json' }
  for (const name of CALLER_HEADERS) {
    const value = callerHeaders[name]
    if (typeof value === 'string' && !/[\r\n]/.test(value)) headers[name] = value
  }
  headers.authorization = `Bearer ${key.api_key}`
  headers['content-length'] = payload.length
  return new Promise((resolve, reject) => {
    // Core HTTP has no ambient proxy or redirect handling. The validated numeric host never performs DNS.
    const request = (url.protocol === 'https:' ? https : http).request(
      url,
      { method: 'POST', headers, signal, agent: false },
      (response) => {
        response.once('close', () => clearTimeout(timer))
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.destroy()
          reject(gatewayError('gateway_redirect_refused', 'Local gateway redirects are not allowed', 502))
          return
        }
        response.once('close', cleanup)
        response.once('error', () => {})
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        resolve(response)
        function abort() {
          response.destroy(signal.reason instanceof Error ? signal.reason : new Error('client_cancelled'))
        }
        function cleanup() {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
        }
      },
    )
    const timer = setTimeout(
      () => request.destroy(gatewayError('gateway_timeout', 'Local gateway deadline expired', 504)),
      Math.max(1, timeoutMs),
    )
    timer.unref?.()
    request.once('finish', onDispatched)
    request.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    request.once('close', () => {
      if (!request.res) clearTimeout(timer)
    })
    request.end(payload)
  })
}

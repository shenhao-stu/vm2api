/**
 * Intercept + rewrite official Claude telemetry bodies.
 * Call chain matches cc-bridge telemetry.rs + rewriter.rs:
 *   is_telemetry_path → fake 200 (auto on) / rewrite (if a body is forwarded)
 * Node never dials Anthropic; rewritten bodies are for the Go sidecar
 * and for stripping caller identity if a client hits these paths.
 */

export function isTelemetryPath(pathname = '') {
  const path = String(pathname || '')
  return (
    path.includes('/event_logging/batch') ||
    path.startsWith('/api/eval/') ||
    path.includes('/api/eval/') ||
    path.startsWith('/api/claude_code/metrics') ||
    path.includes('/api/claude_code/metrics') ||
    path.includes('/api/claude_code/organizations/metrics_enabled')
  )
}

/** A dedicated relay may have no verified telemetry upstream. Default behavior is unchanged. */
export function telemetryIngressResponse(pathname, policy = 'intercept') {
  if (policy === 'reject') {
    return {
      status: 501,
      body: {
        type: 'error',
        error: {
          type: 'not_supported_error',
          code: 'telemetry_passthrough_unsupported',
          message: 'Real telemetry passthrough is not supported; no telemetry was reported',
        },
      },
    }
  }
  if (policy !== 'intercept') throw new Error('Invalid telemetry ingress policy')
  return { status: 200, body: telemetryInterceptResponse(pathname) }
}

export function fakeMetricsEnabledResponse() {
  return { metrics_logging_enabled: true }
}

export function fakeTelemetryResponse() {
  return {}
}

export function telemetryInterceptResponse(pathname) {
  const path = String(pathname || '')
  if (path.includes('metrics_enabled')) return fakeMetricsEnabledResponse()
  return fakeTelemetryResponse()
}

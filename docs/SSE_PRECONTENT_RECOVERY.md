# SSE recovery and execution safety

Keepalive bytes commit HTTP headers but do not commit generated content. This
distinction preserves streaming behavior; it does not by itself permit replay.

A network, timeout or interrupted-stream failure can be retried only when the
transport explicitly reports `transportError === true`, `committed === false`
and `upstreamExecutions === 0`. Unknown execution is returned to the caller,
including exceptions after dispatch. The absence of visible output, a closed
worker job, `executionReleased`, and generic Connection error text are not proof.

HTTP 200 empty or thinking-only generations are never automatically repeated.
Their measured usage and attempt diagnostics are retained with the incomplete
response error. Explicit request/auth/quota rejection remains eligible for the
existing bounded repair/failover policy; timeouts and generic server failures
do not. Measured generation usage also blocks replay, even if a late error is
reported as 400 or 429. Local admission failures can use authoritative zero-dispatch evidence.

Transport recovery remains bounded by the existing attempt, switch, delay and
deadline controls. Setting either transport retry window to zero disables the
same-unit transport recovery. Each attempt has a unique diagnostic sequence,
including attempts that provably dispatched no upstream request.

`hop_meta.attempt_diagnostics` retains the latest 16 allowlisted records, including
`upstream_executions` (null when unknown) and `replay_blocked`. Raw messages, URLs
and credentials are excluded. Generic connection failures do not identify DNS,
TLS or a proxy as the cause.

Local regression: a real HTTP server receives a complete POST then disconnects;
FailoverRunner sends exactly one POST and releases a concurrency-one waiting
request. Further tests cover explicit zero-dispatch recovery, unknown/executed
results and exceptions, incomplete generation usage, 400 repair and 429 failover.

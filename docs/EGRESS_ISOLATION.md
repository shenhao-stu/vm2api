# Egress transport isolation (phase one)

The Claude pool keeps transport health separate from account authentication,
quota and normal capacity. This is an in-process circuit breaker, not a route
migration system and not a fix for an unreachable proxy server.

## Behavior

- Bounded transport recovery requires explicit evidence that no upstream request
  executed. When execution is unknown, the request stops immediately. A specific
  `proxy_transport_failure` still opens the bound exit instead of putting account
  credentials into a network cooldown. A generic connection error alone does not
  identify the proxy as the cause.
- All pool candidates sharing the same bound-route key skip that open exit;
  candidates on healthy exits remain eligible. Normal concurrency/seat pressure
  still uses the existing wait queues.
- When no eligible candidate remains and a bound exit is known unavailable,
  selection returns HTTP 503, `api_error` / `pool_egress_unavailable`, with
  `retry_after_ms` details and the gateway's `Retry-After` response hint. It is
  not reported as upstream overload or an authentication failure.
- The first opening lasts approximately 30 seconds (10% jitter). Failed
  half-open probes back off exponentially to at most 300 seconds. Only one
  half-open reservation per exit is admitted at a time. A verified success
  closes it; cancellation/release frees the probe. Old in-flight results cannot
  modify a newer circuit generation.
- No transparent replay occurs after downstream content or unknown upstream
  execution. No automatic account/proxy rebinding,
  background probe traffic, DNS change or sidecar restart is introduced.

## Identity and operational boundaries

The key is a SHA-256 digest of the bound proxy ID, visible endpoint/configuration
fields, optional revision/config_version, and node ID. Display names are not
identity, and raw credentials are not emitted as a key. Identical bindings on
the same node share state. Different proxy IDs are not merged even when they
happen to reach the same public exit.

State belongs to one scheduler process and is intentionally reset on restart;
there is no cross-process or persistent health coordination. This phase cannot
detect a hidden Mihomo route change behind an unchanged listener. A future
subscription revision must be propagated to the binding snapshot to invalidate
that identity reliably. This phase does not change subscription import identity.

The pool setting `routing.pool.egress_circuit_enabled` defaults to `true`.
Setting it to the boolean `false` and reloading the existing routing configuration
restores legacy selection and proxy-error cooldown behavior. It does not disable
the execution-safety checks or the fixed-egress guard. Existing explicit
VM diagnostic pins bypass the egress gate; they do not clear an open circuit.
This switch has no dedicated new UI control.

## Verification

Focused regression suite:

```sh
node --test test/unit/egress-circuit.test.mjs test/unit/pool-scheduler.test.mjs test/unit/failover-runner.test.mjs
```

The new suite covers shared-exit filtering, explicit 503/retry hints, bounded
transient replay, generation safety, single half-open admission, release,
normal capacity waits, queued-request outage wakeup, diagnostic pins and the
kill switch. These are local deterministic fixtures, not production traffic,
performance or ECH/DNS acceptance tests.

The fixed-egress guard is a separate, persistent protection. Circuit recovery,
probe success and diagnostic pins do not authorize changing bindings, clearing
that guard, bypassing missing credentials, or increasing concurrency.

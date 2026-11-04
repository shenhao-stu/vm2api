# ReClaude readiness and no-replay errors

Use one native state snapshot for an admission decision. Re-reading the state while checking authorization can combine a healthy snapshot with another update, or lose the revoked classification from the first snapshot. Global control-log revocation still blocks admission; malformed or unavailable state remains unavailable. Do not substitute cached healthy state for an unavailable current state.

`native_not_ready` is a pre-dispatch 503. Its audit record contains `readiness_failures`, including native availability, reporting, binding, revocation, state, or official-proof failures. The public error code remains stable for existing native scheduling rules. A historical record lacking these fields cannot establish which check failed.

Keep these other errors separate:

- `native_ingress_busy` is an ingress admission rejection. Check the reverse-proxy connection, request-rate and large-body gates before calling it a provider quota error.
- `native_session_failed_no_replay` blocks a failed session from dispatching another model attempt. Do not clear consumed markers or redirect the same request to another account.
- `native_request_consumed_no_replay` means the dispatch was consumed. Preserve its original result and usage evidence, including a provider quota refusal. Never use a paid request as a quota poll.

Native short cooldowns should expire normally. A native transport recovery does not authorize clearing an exit latch, rebinding OAuth or accepting a different IP. Resume only the independently verified account after a scoped HTTP-worker change; retain per-account concurrency and authentication/session directories.

For rollout, pause only the target upstream account, wait for actual HTTP requests and leases to drain, replace reviewed files, restart the independent HTTP worker, verify current native/egress health, then restore the original scheduling state. Preserve the native daemon, both accounts' identities, and unrelated Pro workers. Tests must cover snapshot transitions, zero-dispatch rejection, revocation, SSE terminal accounting and session isolation.

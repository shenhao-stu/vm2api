# Upgrading an independent native Relay

The Relay HTTP worker is separate from the ReClaude daemon and from ordinary
vm2api OAuth slots. Upgrade that worker without restarting its container, native
authorization, proxy guard, cluster tunnel or the main vm2api gateway.

1. Record the deployed file hashes, native binding, daemon PID/start time,
   container start time, fixed exit and Sub2API account configuration. Verify
   the original exit using two HTTPS services inside the actual namespace.
2. Run the unit suite and real-CLI fixtures with networking disabled. Include
   `tests/offline_tool_history.py`; it verifies the native transcript format as
   well as tools, imported history and tenant isolation. The current format was
   tested against CLI 2.1.304. A CLI upgrade requires this regression again.
3. Pause only this Relay's Sub2API account. Use the existing management agent's
   stop operation to drain the HTTP worker. Both `active_requests` and
   `pending_tools_sessions` must be zero. Never kill a pending paid tool turn.
4. Back up and install the complete adapter change, including the new
   `native_history.py` dependency alongside `native_bridge_session.py`,
   `native_session_pool.py` and `native_http.py`. Preserve the dispatch proxy,
   continuation files, audit, native HOME and authorization latches.
5. Add `--allow-history-import` only when caller-supplied history is required.
   Start the HTTP worker through the native management agent. Check health,
   `history_import_enabled`, concurrency, resident-session limits and memory
   limits. Verify that the native daemon and container did not restart.
6. Use an exclusive, short-lived Sub2API canary group for the existing Relay
   account, with a bounded test key. Run fresh JSON, structured-tool, SSE,
   history-continuation and isolation cases. Capture each intent before sending
   it. A transport error or consumed grant is not permission to resend it.
7. Reconcile final usage across native audit, vm2api, Sub2API and official
   provider records. Verify exact input/output and both cache tiers. Distinguish
   a Relay HTTP attempt from a provider model grant. Sub2API can emit its own
   request ID before upstream headers arrive, so retain both IDs and corroborate
   any bounded-time correlation with the isolated account/key and token totals.
8. Restore the original Sub2API groups and scheduling only after acceptance.
   Revoke the temporary key, remove its group and only its administrator grant,
   and retain the usage ledger. Check ordinary slots, dedicated-user routing,
   fixed exits, process start times and resource pressure again.

On `device_revoked`, pause only the affected Relay account and preserve evidence.
Never clear an exit or authorization latch as part of an upgrade. A rollback
must preserve consumed intents and continuation state; do not recover by
deleting a failed session or importing it under its existing identity.

Tool-result validation follows the upstream protocol: a result containing
`search_result` may contain only `search_result` blocks. Separate results for
different tool calls can use different content types. This is rejected before
dispatch, rather than relying on the upstream API to reject an invalid mixture.

Successful canary responses establish compatibility for the tested cases, not
permanent authorization stability or transparent support for every Messages
parameter. Keep the supported subset and runtime version explicit.

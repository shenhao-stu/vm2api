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

## Caller-reported pending tool inputs

Claude Code can update a tool's input before executing it, such as removing a
redundant working-directory prefix from Bash. This is a caller-owned report,
not a server assertion that two arbitrary commands are semantically equivalent.
Only the final `awaiting_tools` assistant permits input changes; its block order,
IDs, names, text, thinking/signatures and every settled history message stay exact.
The new result set must still match every pending ID without duplicates.

`history-pending` stores the original assistant privately before publishing its
checkpoint. Recovery authenticates the complete original history hash using that
witness. The existing transcript importer carries the caller's reported context
and dispatches only the new tail. `history-adoptions` records both assistant
digests, the original boundary and the full caller-request digest; the new grant
claim binds that record. Preserve both directories alongside caller-grants and
consumed evidence. Missing or corrupt evidence fails closed.

Include `tests/offline_pending_input.py` with an unmodified CLI and outbound
networking disabled. Verify that historical tools do not execute again, the
provider sees exactly one new request per turn, and final usage remains intact.
Legacy pending checkpoints need a separately verified original native SSE/UUID
witness; never derive the old assistant from the current caller's changed input.
Do not erase a session or dispatch an old paid request to recover a prefix error.

## Independent SSH transport recovery

Verify the private HTTP listener as well as the native worker. A worker can be
healthy while its SSH forwarding unit has exhausted systemd's start limit after
a network interruption. For a persistent SSH transport with `Restart=on-failure`,
install `http-tunnel-reconnect.conf` in that unit's drop-in directory. The
30-second retry interval avoids a tight loop; removing the start-count limit
allows recovery after a longer network outage. Enable the transport for boot.
Keep its original loopback bind, destination, strict host-key checking and
exit guard. This setting must not be applied to the OAuth or model worker.

Before recovering a failed transport, verify the original exit and identity.
Afterwards check the health endpoint, listener, effective systemd properties and
unchanged daemon/container start times. Never clear an auth or exit latch to
repair a tunnel. The reconnect policy is transport-only and cannot replay model
requests.

### Divergent responses to one paid input

If a caller finishes a different tool exchange after a paid tool response, retain the original channel, pending tool IDs, receipt and transcript. To open a separate transcript, the Relay verifies the complete prior input hash, the original paid response checkpoint, the alternate tool results and one fresh user tail under the same authenticated scope. It imports the caller-provided history and dispatches only that tail. Both transcripts share consumption checks and the account's concurrency limit.

Back up the configuration-channel registry together with its session directories. Once a registry contains a `paid_sibling` record, roll back to a version that understands it, or keep that Relay out of scheduling until it can read both histories. Keep all caller grants, consumed records and pending witnesses.

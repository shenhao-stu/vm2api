# Native Relay upgrades without changing OAuth slots

Each Relay has an independent HOME, device binding, HTTP worker, ledger and
session store. A shared read-only binary directory is **not** a shared identity.
Never replace its unversioned executable while another Relay is running.

For the validated v1.8.3 release, download the Linux amd64 artifact and matching
vendor checksum from the official ReClaude distribution. Keep a versioned file,
then point the selected HTTP worker's existing `--reclaude` option at it.
The verified artifact SHA256 was
`c05f19b2a7df161654813ffad2a2bceb85ba080c1151ee0a0ad2ffd446d715ab`.
Official installation and lifecycle references:
https://docs.reclaude.ai/cli/install and https://docs.reclaude.ai/cli/commands.

1. Record the running container/image, native CLI hash, binding, fixed-exit guard,
   Sub2API routing profile, quota and in-flight/tool counts. Pause only the chosen
   Sub2API account. Drain through its management agent; unresolved caller tools
   must finish naturally before stopping its HTTP worker.
2. Keep OAuth, consumed-request records, transcripts and every guard/latch intact.
   Inventory `_daemon` processes **inside the selected container**: executable,
   PID, start time, HOME and log destination. Use the vendor's stop command, then
   verify no daemon for that HOME remains before starting the **versioned**
   executable with `RECLAUDE_AUTO_UPDATE=0`. A successful `service restart` exit
   code alone does not establish this invariant. Preserve the device and CLI.
   If stop leaves a process behind, verify its exact PID/start time/executable,
   same HOME and drained worker before terminating only that process. Never
   kill by a broad name or touch another container. Wait for every old process
   to exit before starting: its shutdown can overwrite the shared state file.
3. Wait for native identity/policy synchronization. A startup check can briefly
   report `native_unavailable`; inspect readiness again without sending models.
   A revoked authorization stays paused for investigation. Never clear that error
   just to make an upgrade pass.
4. Verify exactly one live daemon, its PID matching native state, `cli --version`,
   native health and both fixed-exit sources before
   starting the HTTP worker. The tested combination is ReClaude v1.8.3 with the
   existing Claude Code2.1.304. No native Pro/Max CLI update was needed.
5. Add the canonical `claude-fable-5-2` model through the dedicated gateway's
   native endpoint API, management configurations, shared routing profile and
   Sub2API model mapping. Endpoint `id` is an internal row ID: the canonical model
   belongs in **both `name` and `alias`**. Read back all three fields. Preserve
   existing models, endpoint keys and per-account routing.
6. Use a new bounded canary key/group restricted to this one account. Validate
   SSE terminal events, caller tools, unmodified history continuation and JSON
   Message shape. Reconcile each request's token counters and one billing entry.
   Do not repeat consumed requests after a test assertion fails; inspect saved
   responses and use a new independent case only when necessary.
7. Remove the canary key/group/grant and restore the original shared groups.
   Keep genuine official quota cooldowns. Monitor natural requests, authorization
   and resource use; a short acceptance cannot establish permanent stability.

The HTTP unit must retain its versioned path after restart. Existing containers
are intentionally not automatically recreated or unlatched on a host reboot;
the recovery runbook must start the same pinned ReClaude version after verifying
the fixed exit. Do not restore an old credential snapshot as a binary rollback.

## Rebinding and daemon ownership

A November 11 recovery exposed two native daemons sharing one HOME and log.
The current device was active and its account gateway was healthy, while the
older daemon continued receiving `device_revoked` during control synchronization.
Admission correctly remained closed. A later restart also left the prior daemon
alive; terminating it overwrote the new daemon's state with PID zero. Starting
only after the process count reached zero resolved both symptoms. Check processes
as well as state after every lifecycle operation; never suppress control errors
or discard the log to make readiness pass. This explains the post-rebinding
failure, not the provider's original decision to revoke the old device.

After an explicitly authorized rebind, update the selected worker's binding,
management configuration and official-quota reader/publisher together. Keep
account, organization, fixed exit, keys, session data and consumed-request records.
Only archive the exact old authentication latch after fresh official device and
quota verification, two-source exit verification and native health agree.
Quota recovery alone never authorizes clearing an authentication or exit latch.

The recovered account then completed two new Fable5.2 streamed turns in an
exclusive Sub2API canary: a caller tool invocation and its unmodified history
continuation. Both finished on the selected account with one native attempt and
one billing record; all input/output/cache counters reconciled. Existing consumed
records remained byte-identical. The temporary key/group/grant were retired and
the original shared groups restored. This is bounded acceptance, not a guarantee
against future device revocation.

Older deployments copied their own quota parsers. Use `official_windows.py` and
`publish_official_windows.py` from this integration instead: official 5H=0 with
`resets_at=null` is valid. A nonzero used amount without a reset remains invalid.
A missing reset must not break management status/stop, invent quota or clear7D.

## 2026-11-11 bounded acceptance

Both independent Relays retained their device bindings, fixed exits, concurrency10,
4GiB limits and existing CLI. Five fresh Fable5.2 calls through Sub2API and the
isolated vm2api gateway completed on the selected account, with matching token
counts and exactly one billing record per call. Tests exercised SSE, tools, JSON
and a separate unmodified two-turn conversation. No paid request was replayed.
The other account was independently healthy but at official7D100%; its model
cooldowns were preserved rather than using a paid call to probe exhausted quota.

An intentional caller-side tool-input rewrite made the model add a correction
note in the first fixture's third response. Its JSON/protocol and marker were
correct but an exact-text assertion failed. The subsequent new unmodified history
fixture passed exact assertions. Keep this distinction when evaluating adapter
correctness; do not remove isolation protections to force a model's wording.

## Host reboot and pre-dispatch recovery

A host restart can leave SSH/socket forwarding available before its native HTTP
listener. That produced EOF at the upstream gateway during a November 11 recovery.
Use `Manager.action("stop", operation_id)` to pause Sub scheduling before draining
and stopping a worker. Calling only `runtime("stop")` does not pause scheduling.
Resume through the manager only after the fixed exit, original binding, private
DNS and isolated network rules, native daemon and HTTP listener pass their checks.
Do not flush shared firewall tables, enable public DNS fallback, or automatically
rearm an exit/authentication latch. A management tunnel should not share its
lifecycle with one account's guarded egress tunnel.

Configuration synchronization may fail before the CLI receives a user turn.
`native_policy_not_ready_no_dispatch` now uses the existing initialization-boundary
recovery: both processes must be stopped, fresh dispatch counters must be zero,
and the checkpoint, grants and consumption records must remain unchanged. The
failed CLI is retired; only a later caller request may continue. Unknown or paid
failures retain their existing protections. This does not retry or erase requests,
relax native policy checks, or clear old failed sessions automatically.

For a legacy failed session, preserve evidence first. One incident was manually
archived only after confirming an empty output log, no caller grant or consumption
record, matching native configuration-timeout evidence, zero dispatch counters and
a sole-member registry while the worker was stopped. Do not generalize this to an
unknown session or edit a paid transcript. Regression covers a real child exiting
during configuration sync, prepared and imported histories, prewarming, and unknown
or nonzero dispatch observations. Local and production-image isolated suites each
passed 336 tests; no provider request was needed for those tests.

Native Fable quota refusals can also use `model_requires_usage_credits`. The
zero-use quota proof accepts that code only when the assistant and terminal result
agree, the existing zero-token/zero-cost and dispatch evidence checks pass, and
the official reset has elapsed. It retains paid/unknown deduplication and does not
change current cooldowns. Map a witnessed Fable-specific window to Sub2API's native
model cooldown, preserving access to unrelated models. A consumed dispatch marker
means the turn was sent; it does not by itself prove that the provider charged it.
The two quota regressions bring the isolated suite to 338 tests on both hosts.

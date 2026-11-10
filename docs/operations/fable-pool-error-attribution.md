# Fable pool failures and nonstreaming errors

A transport failure on the only account allowed by a key must remain a transport
failure after that account is excluded. An empty Fable pool is not evidence of a
missing Max subscription. Only explicit slot entitlement rejections may produce
`fable_requires_max`; local quota and capacity restrictions retain their own
reason and reset information.

Local quota admission runs before worker health I/O. This avoids remote health
latency for a request already blocked by policy. Successful candidates still
undergo credential/worker checks and quota is checked again when reserving the
account. Fixed egress, per-account concurrency, explicit model allowlists,
promotional expiry, and session refusal protection remain independent gates.

Regression coverage in `test/unit/pool-scheduler.test.mjs` includes a single-slot
Fable connection failure before and after downstream commitment, rejected quota
without remote health calls, and quota consumed while health is pending. No
production requests or credentials are used by these tests.

## Deployment boundary

The running gateway loads JavaScript at startup. A source commit alone does not
activate the fix. Deploy the reviewed scheduler file into a copy of the current
production source, drain requests, and reload only the native gateway in an
approved maintenance window. Restore only the previously running slots after
independent probes confirm their existing fixed exit addresses; never clear
previous safety latches or revive retired accounts. Preserve the existing CLI,
kernel, ReClaude services, Codex service, account state and billing ledger.

## Recovery verification

Rearming an exit guard does not start its stopped worker. Use the native start
operation, wait for diagnosis, and only then restore the corresponding downstream
account. Verify the account identity, key scope, model policy and concurrency
against the pre-maintenance snapshot. Read back uncertain actions; never replay
an ambiguous start or dispatch.

A remote slot start can recopy bundled auxiliary binaries even when its existing
egress helper remains running. Record both the running executable hash and the
on-disk artifact hash before maintenance, then compare both after starting. A
successful guard probe alone does not prove an earlier DNS fix was preserved.
Restore a reviewed slot-specific artifact atomically if it was overwritten; do
not replace a shared CLI/kernel or restart unrelated helpers. Preserve these pins
in future recovery procedures as well as the gateway image manifest.

## Separate nonstreaming transport limitation

A JSON whitespace keepalive commits HTTP 200 before the final response is known.
A later JSON error cannot change that HTTP status and some clients then report
“JSON but not a Message.” This patch fixes native error attribution and avoids
unnecessary admission I/O; it does not claim to eliminate that HTTP limitation.
Do not fabricate a successful Message or replay an ambiguous dispatch to hide it.
Disabling keepalives globally also requires checking long successful requests
against intermediate proxy timeouts. Streaming requests should receive explicit
error events and must not be mistaken for successful billable completions.

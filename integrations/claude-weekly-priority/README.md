# Claude Pro weekly-reset scheduling

An optional controller projects the VM page's effective `reset_7d` metadata onto
Sub2API's existing account priority. It does not change either inference engine.
This is useful when every upstream Sub2API account has its own slot-scoped key:
vm2api's internal credential weighting cannot choose between those keys.

`priorities` and `plan` are pure functions. The controller owns observation,
durable field-write intents and timing. A deployment adapter supplies three methods:

- `snapshot()`: `{captured_at, slots: [{id, tier, reset_7d}]}` from the same effective
  reset shown by the VM page, without triggering provider/model requests.
- `accounts()`: mapping of integer account IDs to priority, status, schedulable and
  the explicitly pinned structural fields in each binding.
- `set_priority(id, before, after)`: compare the current priority and structural
  fields again, acquire the deployment write lock, update **only** priority using
  the native administration API, then verify the complete protected projection.
  Raise on races; never retry a mutation without reading its result.

## Policy

Smaller priorities are preferred. Distinct future Pro deadlines rank 1–38; equal
ones tie and use native load balancing. Unknown, stale or expired windows rank39.
A fresh next-week reset sorts behind closer deadlines. Reaching a deadline does
not prove quota was replenished: existing utilization/cooldown and 85% protections
remain authoritative. The controller never invents a new reset date.

The inspected deployment reserves Max5x40, ReClaude50 and existing fallback100.
Those bands are configured once through native APIs, not repeatedly overwritten
by this controller. Existing session stickiness, group membership, private-user
affinity, credentials and concurrency remain authoritative. The priority affects
new eligible selections; it does not migrate a running conversation.

Metadata is sampled every20 seconds with an extra wake at a known deadline.
A cached snapshot remains usable for90 seconds after collection; even while a
refresh fails, elapsed deadlines are demoted. Older data assigns all managed Pro
accounts39. It never enables a disabled account. Operator priority changes or a
changed structural binding relinquish control of that account. After a confirmed
write, even manually returning to its original priority is respected.

The bound list is explicit. Onboard new accounts only after checking their
one-slot key, group/user scope and concurrency. More than38 distinct deadlines
fails visibly instead of crossing the Max/Relay bands.

## Deployment

Run `python3 controller.py --config /private/config.json`. The JSON has `adapter`
(module path), `state` (0600 durable JSON) and `bindings`; each binding contains
`slot_id`, integer `account_id`, `initial_priority` and `expected` structural fields.
Use an independent service with128MiB memory/15% CPU limits and a20-second restart
backoff. Keep state and deployment-specific credential adapters outside Git.
`--once` is a **mutating** single cycle, not a dry run; call `plan` for previews.

The production exporter is restricted by a forced SSH command, source-IP allowlist,
pinned host key, no forwarding/PTY and a metadata-only response. No new public
listener exists. Credentials stay on their existing servers. The writer coordinates
with the existing release lock and uses native account updates, not SQL writes.

Stop the independent controller to roll back. Restore only priorities still owned
by its recorded state; do not overwrite later operator changes. No gateway or
slot restart and no exit-guard rearm is required.

Validation: `python3 -m unittest discover -s integrations/claude-weekly-priority`.
Tests cover exact deadlines, reset crossing, stale/future clocks, manual controls,
private bindings, inactive accounts, uncertain writes and confirmed ownership.

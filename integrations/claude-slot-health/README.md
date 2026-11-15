# Claude slot health projection

This optional controller keeps explicitly bound one-slot Sub2API accounts paused
when native vm2api records a stopped, manually paused, revoked or failed expired
credential. It uses metadata only; it never calls a model, refreshes OAuth, clears
quota, rearms an exit guard or enables a Sub2API account.

`policy.py` is pure. The deployment adapter implements `snapshot()`, `accounts()`,
`pause(change, before)` and `priority(id, before, after)` using the native admin APIs.
Every write revalidates the exact account's key hash, groups, concurrency, URL and
current state under the deployment release lock. Only the scheduling flag or the
priority field is changed. An uncertain write must be read back before retrying.

Snapshots expire after 60 seconds; missing/duplicate slots and changed account
bindings abort the cycle. Provider 429s, network failures and ordinary quota
cooldowns are not permanent credential rejection. Existing native protections
remain authoritative. The 30-second watcher complements the synchronous native
credential admission gate; it does not replace that gate.

Optional weekly priority is restricted to explicitly marked shared Pro bindings.
Within the configured band, future reset times use native rolling-day buckets;
an elapsed or unknown reset sorts last. Manual ranks outside the band are kept.
Priority changes do not move existing sessions. Dedicated accounts are pause-only.

Keep adapters, actual bindings and state outside the repository. Install as an
independent systemd service with 128 MiB memory, 15% CPU, no new public listener,
and a restricted metadata-only SSH command. Roll back by stopping this service;
never enable accounts automatically as part of rollback.

Run `python3 -m unittest discover -s integrations/claude-slot-health`.

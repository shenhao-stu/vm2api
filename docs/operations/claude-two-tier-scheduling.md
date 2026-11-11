# Claude shared-pool scheduling

The deployment uses native Sub2API priorities for account families and native vm2api VM pools for Pro selection. No scheduler code, Claude CLI or gateway reload was needed for the configuration change on 2026-11-12 CST.

| Route | Sub2API account | Priority (lower first) | Concurrency |
| --- | --- | --- | --- |
| Native Max5x | 34038 | 0 | 5 |
| ReClaude | 33871 / 33978 | 10 | 10 each |
| Shared native Pro pool | 34043 | 10 | 11 aggregate, 1 per slot |

Priority applies to eligible account selection. Existing session affinity, model permissions, quota protection, manual stops and exit guards still apply. Sticky sessions are not migrated to a different account just to improve reset order. Equal priority is not a guaranteed equal traffic share.

## Pro selection

The named VM pool `pool_978d75ba` contains shared slots 04, 06, 08, 10, 11, 14–19. Its independent Key `key_2eab9558ad6a` is installed in Sub2API account34043, using the existing private bridge. It does not include Max, ReClaude, U134 private slots01/05 or retired slots12/13. An empty or disabled pool fails closed.

All members retain native automatic priority (`policy.priority` unset). Remaining weekly reset time determines rolling 24-hour buckets:

| Remaining time | Native level (higher first) |
| --- | --- |
| Under 24 hours | 7 |
| 24–48 hours | 6 |
| 48–72 hours | 5 |
| 72–96 hours | 4 |
| 96–120 hours | 3 |
| 120–144 hours | 2 |
| At least144 hours, expired or unknown | 1 |

Within a level, native load selection applies. A reset falling due immediately returns to the lowest level; stale quota is not treated as fresh entitlement. Reset metadata comes from the existing quota paths, not paid keepalive calls. Native 85% Pro quota protection, promotion deadlines, refusal-session quarantine and per-slot model rules remain active.

## Scope, lifecycle and expiry

The former eleven shared Sub accounts are paused and retained with their independent upstream Keys for rollback and diagnosis: 33858, 33860, 33870, 33872, 33873, 33877–33879, 33977, 33979, 34031. Do not enable these routes alongside the aggregate as an alternative scheduling path. Pausing those Sub routes does not stop their native slots.

U134 remains isolated through accounts33850/33859, group25 and its existing affinity tag. The old weekly-priority metadata controller now owns only these two private bindings; it cannot overwrite the shared tiers. No credentials, HOME directories, device identities or conversation stores were merged.

Groups5/7/8/19/24/25 include the aggregate. Fable5.2 routing in groups8/25 includes it for the existing Pro promotion, and compatible ReClaude accounts remain eligible. The existing expiry service includes account34043 and removes its temporary Fable5.2 mappings at `2026-11-17T07:59:00Z` (exclusive). Native per-slot expiry is retained independently. Account tier remains Pro.

New shared Pro accounts require explicit pool membership after their fixed-exit, authorization, concurrency and isolation checks. Increase aggregate capacity only when the new member is ready. Never replace this Key with an unrestricted all-VM Key.

## Verification and rollback

The existing native pool/priority/scope/sticky/quarantine suites passed222 tests. Live API, database and both scheduler caches confirmed the tiers; old shared routes had no in-flight or queued requests. The new Key passed a free `/v1/models` request over the private bridge. All11 pool members were running with original fixed exits and concurrency1. No customer request was replayed and no paid model probe was issued. No new native completion had arrived during the final observation window; this is configuration validation, not a new end-to-end model acceptance claim.

Before rollback, pause34043, allow in-flight work to finish, and re-read every old account's current authorization, quota and exit state. Restore only eligible routes and their reviewed group mappings; do not clear a cooldown or latch. Restore the old weekly controller bindings only if the former architecture is intentionally restored. Protected before-snapshots and one-time receipts are in the private `two-tier-priority-20261112` run directories on HappySrv and Netcup; do not blindly replay the deployment scripts.

# Native Relay management in the VM console

This optional integration adds a **native Relay** section to the main VM page.
It does not register the ReClaude container as a kin OAuth slot: kin's reset,
kernel, credential import and device operations do not apply to this runtime.
The existing Pro VM list, pool and lifecycle remain unchanged.

The management server binds **loopback only**. Reverse-proxy
`/api/panel/native-relays` to it on the main console origin. Every request is
authenticated against the main panel's live `/api/panel/me` endpoint and requires
the admin role. Mutations also require the configured Origin, JSON content and a
fresh UUID operation ID. An ambiguous or consumed operation cannot be replayed.
Other deployments may omit this route; the UI hides the optional section on 404.

Configure administrator-owned JSON with these fields (no client-supplied paths):

| Field | Meaning |
| --- | --- |
| `id`, `name`, `node` | Stable runtime ID and display labels |
| `binding`, `sub_account`, `concurrency`, `models` | Accepted native device and dedicated account policy |
| `guard_file`, `guard_revision`, `expected_ip` | Existing exit guard; read only |
| `guard_source` | Optional `runtime`: validate the NAS agent's live guard snapshot against the same pin/revision; never fall back to a local shadow |
| `state_dir` | Private management intents, audit and authorization latch |
| `panel_me_url`, `origin` | Fixed main-panel authentication URL and public console origin |
| `runtime_command` | Fixed argv invoking `management_agent.py CONFIG` over existing SSH |
| `sub_command` | Fixed argv invoking the scoped Sub2API broker |

Run `management_server.py --config CONFIG --port LOOPBACK_PORT` with restrictive
file permissions and systemd resource limits. The included `management_sub.py`
uses the existing **local** native Sub2API admin helper. A dedicated SSH key can
be limited with `restrict,command="python3 BROKER CONFIG"`; generate the private
key on its owner host and copy only the public key. This broker changes only the
configured account's `schedulable` field, never groups, credentials or other
accounts. Resume verifies the account's base URL, groups, model list and limit.

The NAS agent config names its existing `home`, `binding`, `container`, `unit`,
`expected_ip`, HTTP `state_dir`, `auth_latches` and private `health_url`.

- **Shared-pool scheduling:** `pause_schedule` and `resume_schedule` change only
  the dedicated Sub2API account's native `schedulable` flag. They preserve active
  requests, waiting tool continuations, prewarmed CLI sessions and OAuth. Direct
  Relay API access is unaffected. Resume requires the running worker, original
  authorization and a fresh fixed-exit verification. It cannot restart a stopped
  worker, clear an authorization/exit latch or remove a native quota cooldown.
  Unknown outcomes must be read back, never automatically retried.
- **Stop Relay:** pause its Sub2API account first, close new admission, wait for
  active requests and final usage, then stop only the HTTP worker. If draining
  takes too long, leave it paused and running; do not kill a charged request.
- **Start Relay:** require healthy original native authorization and the unchanged,
  fresh exit guard; verify the container's exit with two HTTPS services, start
  the worker, check readiness, then resume the dedicated Sub account.
- Native container/HOME, OAuth daemon and telemetry remain running and intact.
  Buttons intentionally control the Relay worker, not device enrollment or the
  host VM. Container state is displayed separately.
  Completed turns retain their verified continuation checkpoint. A completed
  tool-use turn can resume after the idle CLI is suspended, with exactly the
  pending caller tool results. Failed/in-flight turns remain blocked.
- A confirmed native revocation or auth latch pauses the dedicated account before
  persisting management evidence. A 30-second read-only watcher performs this
  check without model requests. It never rebinds, rearms an exit guard, accepts a
  new IP or clears an authorization latch. Errors never mean healthy.
- Logs expose only bounded request metadata, terminal usage and management events;
  no request bodies, prompt history, tokens or raw daemon logs.

Use `native_service_control.py` for the worker's systemd prepare/stop hooks. Its
bind check uses the same `SO_REUSEADDR` as the HTTP server, allowing restart after
completed health connections while still refusing an existing live listener.
The stop helper verifies the recorded PID belongs to the configured HTTP worker.
It never targets the ReClaude daemon.

## Compatibility and deployment

Sub2API's native account test sends `temperature: 1`. The native backend accepts
only that numeric default, normalizes it with omission for session continuity,
and lets the genuine CLI use its default sampler. Non-default/invalid values and
unknown parameters remain pre-dispatch errors. This follows the
[official API migration guidance](https://platform.claude.com/docs/en/api/migration-2026-10-21).
Fable remains allowed on this independent API backend; Pro-slot Fable bans are
unaffected.

For a live deployment that cannot reload the main gateway, publish the console
static build in a separate asset namespace and add exact Nginx console-index
locations plus the management route. Run `nginx -t` and gracefully reload only
Nginx. Retain the original assets and all other locations for rollback. This does
not change the main gateway image or implicitly restart its slots/exit helpers.
Persist and document this frontend overlay for the next full gateway upgrade.
Check every local JavaScript/CSS URL referenced by the actual index, including
its module imports, and open the keys page in a real browser. An index returning
200 does not prove its assets exist. When assets use `/assets/`, serve that path
from the same build, with the prior gateway as a fallback for old hashed files.

Before replacing the separate HTTP worker, pause only its Sub account, drain and
back up the exact source/unit hashes. Keep the original native daemon and guard.
Afterwards compare all protected Pro slots, keys, proxies, concurrency and guest
start times. On failure leave the new account paused, repair or roll back only
these independent components; never restore entire databases or OAuth homes.

With history import enabled, callers may return after completing additional
turns elsewhere. Their history must still contain the exact saved prefix and a
complete tool-result graph. The adapter preserves the old native transcript,
imports the extended context into a new segment in the same authenticated
session directory, and dispatches only the final new user input. Changed prefix,
model/system, unfinished paid turns and duplicate requests remain rejected.

Tests use local fixtures and a network-disabled genuine CLI, including Fable,
default sampling, terminal SSE, authorization failure, drain and original-IP
gates. This proves adapter compatibility without buying model calls; it is not a
claim of a fresh paid Fable generation or permanent authorization stability.

### Relay usage and official plan usage

Each Relay management configuration can select a read-only SQLite ledger with
`usage_ledger: {"path": "/private/gateway/data/kin.db", "account_id": "ek_..."}`.
Use the native backend account ID. Rotating an inbound API key retains the
account's usage. The rolling five-hour, seven-day and retained-history totals use
`usage_logs.total_cost` in USD, including metered partial responses. The UI
reports records without pricing separately. A missing ledger displays an
unavailable state.

The card labels these amounts **本 Relay / 近5H / 近7D**. Official percentage
windows are labeled **官方 · 全员** because other members and devices using the
same upstream account also consume them. The rolling local amounts and fixed
official reset windows have different boundaries; do not subtract them to
estimate another member's use. Dollar plan balances and percentage windows have
independent freshness indicators. A passed reset retains the previous reading
with a stale warning until a new official observation arrives.

Quota-aware scheduling belongs to Sub2API's native account/model cooldowns,
not the display. A consumed native rate-limit result may record the model's reset
time for subsequent requests, but must retain `no_replay` for the request already
dispatched. Do not convert that result into a retryable response. Carry full
client history when switching between Relay and Pro; an upstream session ID alone
cannot transfer context. Fable must never fall back to Pro accounts.

For the official quota, configure `official_quota` with a private snapshot
`path`, the ReClaude `org_id` and the provider's numeric `account_id`. The
snapshot is also scoped to the configured native device `binding`.
`quota_sync_mac.py CONFIG` uses a selected, logged-in Chrome profile through
the installed TMWD stdio bridge. It reads the first-party billing and device
APIs inside the browser. Only the matching organization, account, device,
amounts and timestamps leave Chrome. Its trusted local config names the
`profile`, `binding`, `org_id`, `account_id` and fixed argv
`publish_command`. Use an existing private operator transport to run
`python3 publish_official_quota.py MANAGEMENT_CONFIG` with the observation
on stdin. The publisher checks scope, recency and order before atomic replacement.

A reader interval of five minutes fits the ten-minute freshness indicator.
When Chrome is offline, its login expires, or the reported window resets,
the card dates the last observation. The organization window can also include
activity from other devices. Both views are admin-only and independent of Relay
admission and lifecycle.

### Multiple native accounts

Repeat `--config` for each enrolled account on the same loopback management server. Give each configuration its own Relay ID, device binding, Sub2API account, state directory and fixed broker commands. All entries use the same panel authentication URL and browser origin. Each monitor refreshes its own account. A controller outage or device revocation is reported on that account's card. Start, stop and log requests carry the Relay ID in the path. Keep one native HOME, worker port, session directory, API key and usage ledger per account.

Use the account's own verified model allowlist in Sub2API. During enrollment, test through a temporary group containing only that account and reconcile each terminal response with the native and Sub2API ledgers before admitting shared traffic. The per-Relay concurrency limit applies independently.

The default native worker still waits for the organizational policy confirmation. For a personal Max binding, the worker supports `--recognize-personal-max`. It requires the genuine CLI initialization to report first-party Claude Max, the same current binding and matching native OAuth profile. Managed or ambiguous accounts retain the organizational policy check. Never share a policy cache or OAuth directory across devices.

For account-window billing, set `quota_kind` to `account_windows` in the Chrome reader and set `account_windows` in the NAS agent config with its `path`, `org` and `account_id`. Use a separate installed reader and snapshot for each account. The existing `carpool` reader keeps the USD format. The optional `app_url` selects an allowlisted official portal with the login for that account. Percentage windows and dollar balances are displayed separately. When multiple devices use the same subscription, they share its official allowance.

Install `official_windows.py` alongside the management agent and
`publish_official_windows.py`. The reader's publisher command runs
`python3 publish_official_windows.py MANAGEMENT_CONFIG` with the observation on
stdin. The publisher verifies the configured organization, account and current
native device, then atomically replaces only a newer observation. It never
changes authorization, scheduling, cooldowns or exit guards.

An official zero-percent window with a null reset is valid: no new session
window is active. A nonzero window requires a reset time. Expired observations
remain visible as stale; they never become synthetic zeroes. Keep each account's
browser login available for its own reader. A missing login preserves the last
observation and marks it stale instead of reading another account's quota.

Accounts that share a Sub2API pool can reference one operator-owned JSON file using `shared_routing_profile` in each forced-command broker config. Start from `shared-routing.example.json`, fill in the intended shared group IDs, and apply its model mapping, priority, concurrency and cooldown rules through the native account API. Status reports `shared_policy_matches`. Resume checks the shared policy before changing scheduling. Pausing a revoked account remains possible during configuration drift.

Sub2API's native scheduler can keep a healthy session on its selected account and choose another available account when a failure precedes dispatch. A temporary-unschedulable rule matching HTTP 400 `native_request_consumed_no_replay` makes Sub2API treat the error as a failover signal. Leave that rule out. A consumed request or an already-streaming response must keep its original outcome. Preserve the native runtime's no-replay response and its evidence.

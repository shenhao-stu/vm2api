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

- **Stop Relay:** pause its Sub2API account first, close new admission, wait for
  active requests and final usage, then stop only the HTTP worker. If draining
  takes too long, leave it paused and running; do not kill a charged request.
- **Start Relay:** require healthy original native authorization and the unchanged,
  fresh exit guard; verify the container's exit with two HTTPS services, start
  the worker, check readiness, then resume the dedicated Sub account.
- Native container/HOME, OAuth daemon and telemetry remain running and intact.
  Buttons intentionally control the Relay worker, not device enrollment or the
  host VM. Container state is displayed separately.
  Completed turns retain their verified continuation checkpoint. A conversation
  awaiting an external tool result is not restart-resumable: stopping the worker
  ends that tool wait, and the incomplete-turn guard prevents automatic replay.
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

Before replacing the separate HTTP worker, pause only its Sub account, drain and
back up the exact source/unit hashes. Keep the original native daemon and guard.
Afterwards compare all protected Pro slots, keys, proxies, concurrency and guest
start times. On failure leave the new account paused, repair or roll back only
these independent components; never restore entire databases or OAuth homes.

Tests use local fixtures and a network-disabled genuine CLI, including Fable,
default sampling, terminal SSE, authorization failure, drain and original-IP
gates. This proves adapter compatibility without buying model calls; it is not a
claim of a fresh paid Fable generation or permanent authorization stability.

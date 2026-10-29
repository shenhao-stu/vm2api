# Isolated ReClaude relay

This optional integration connects a separate vm2api API-backend instance to a
native ReClaude daemon. It does not alter existing OAuth slots, accounts, proxies,
or the default vm2api behavior. Source: the reviewed reclaude2api server handoff
dated 2026-10-28; its older vm2api snapshot must not replace this repository.

```text
Sub2API shared account (configured concurrency)
  → dedicated TLS Messages path / separate vm2api data directory
  → loopback adapter:18786 (configured concurrency)
  → native ReClaude daemon (same network namespace)
  → ReClaude service
```

## Verified release scope (2026-10-29)

A separate Linux deployment passed native authorization, fixed-egress checks,
real Claude Code SSE, and Messages JSON/SSE through a one-account Sub2API canary.
It now participates in shared groups with concurrency 10 and no user affinity.
The original seven OAuth slots, their proxies, concurrency 1, routing, keys and
container lifecycles were preserved. The new instance is not an ordinary OAuth
slot and must not be added to that allocator.

The accepted model is **claude-sonnet-4-6 only**. This organization rejects
ordinary SDK clients: use real Claude Code with its documented custom base URL
and gateway authentication. Do not forge a client identity to remove that limit.
Tools, thinking, long conversations and ten simultaneous paid calls were not
validated online. Concurrency 10 and session separation were tested offline;
short successful calls do not establish long-term provider authorization.

The first server organization was manually unbound by its owner before model
use. That retired binding stays stopped. Native reauthorization selected the
operator's intended organization; no credentials were cloned from a Mac or an
old slot. Exact deployment IDs, secret paths, receipts and rollback steps belong
in the private project handoff, not this public repository.

## Behavior and boundaries

- `KIN_API_PASSTHROUGH=1` applies only to API-category keys on a **separate
  instance**. It accepts Anthropic Messages, preserves caller metadata and
  approved actual protocol headers, and skips persona/tool/classifier
  substitutions. Native message validation, model selection, limits, and SSE
  conversion still apply: this is semantic forwarding, not byte-for-byte HTTP
  tunneling. Default instances retain their existing behavior.
- `KIN_TELEMETRY_INGRESS=reject` returns an explicit 501 for recognized telemetry
  ingress. It does not claim that telemetry was delivered. Leave the native
  ReClaude daemon's own reporting unchanged; do not invent missing client
  signatures or request IDs. Custom API clients are not equivalent to the
  complete native Claude Code flow.
- The adapter accepts one exact credentialed binding, rereads its credential
  on every request, verifies TLS with the native CA, and has no direct fallback
  or retry. It only fills an absent account UUID in an existing JSON user ID;
  it never replaces a caller's device/session ID or adds previous messages.
- A relay key authenticates the gateway, not downstream people. Sub2API must
  authenticate users and supply explicit request messages. This adapter stores
  no conversations. Shared upstream-account caches remain an upstream feature;
  local statelessness is not a claim of provider-side tenant separation.
- Each in-flight request owns one bounded concurrency permit through the terminal SSE event
  and socket cleanup. Body/response sizes, connections, and total duration are
  bounded. Invalid requests are rejected before dispatch. A broken stream is
  reported as an error, never a synthetic successful `message_stop`.
- A native `device_revoked`, upstream 401, or explicit authentication-revocation
  error latches the adapter. The latch survives restarts. A generic model
  permission 403 does not disable the whole binding. Manual recovery must
  inspect native status and the fixed-IP guard before clearing a latch.
- Audit JSONL contains timing, status, model, byte/token counts, terminal state,
  actual upstream request ID, and an identity digest. It excludes prompts,
  response text, keys, credentials, and raw headers. Logs rotate at 5 MiB × 4
  files. Use `KIN_REQUEST_LOG_MODE=normal` for gateway summaries and keep native
  `reclaude capture` off.

## Prepare without touching existing services

1. Record current slot IDs, container IDs/start times, routing, key permissions,
   proxy-guard policies/revisions, and host memory. Create a separate directory,
   HOME, database, master/admin/relay/downstream secrets (0600), network, and
   resource limits. Do not mount an existing slot's HOME, fingerprint overrides,
   or Docker socket into the new gateway.
2. Verify the official ReClaude binary checksum. Use native `reclaude login`
   for the new machine, after stopping the old independent binding's use. Do
   not copy device credentials between machines. Do not touch daily-use Mac
   ReClaude or another account's authorization.
3. Reuse the native fixed-exit helper. Test two HTTPS IP sources from inside the
   actual runtime. Require the specified IP and a ready, unlatched guard. Keep
   bridge forwarding blocked outside the proxy and DNS path. Never accept a new
   IP or clear a guard latch as part of deployment.
4. Run the native daemon in the foreground as its own supervised container,
   with a persistent private HOME and real machine identity. Read its current
   port using `reclaude status`; the adapter follows the native state file after restarts; do not use `--version` as a readiness check.
   Confirm the intended organization, exactly one credentialed binding, and no
   native revocation. A reachable local TCP port alone is insufficient.
5. Build an overlay from the exact tested vm2api image. Verify its package-lock
   hash matches this checkout first. The integration Dockerfile copies source
   and tests; it deliberately reuses that image's reviewed native binaries and
   installed dependencies. Run the tests below in the candidate with no network
   or production mounts before enabling any account.
6. Start adapter and gateway in the daemon's network namespace. Adapter binds
   loopback only; the gateway can bind a private address reachable by Nginx.
   Do not publish the daemon, adapter, or panel ports. Recommended initial caps:
   daemon 512 MiB, gateway 512 MiB, adapter 384 MiB, each CPU ≤ 1; these are caps,
   not reservations. Verify real peak use rather than multiplying idle samples.

Adapter entry point (paths are deployment parameters, not repository secrets):

```sh
python3 adapter.py \
  --rec-home /home/kincli/.rec \
  --ca-file /home/kincli/.rec/ca.pem \
  --key-file /private/relay.key \
  --trace-file /audit/requests.jsonl \
  --latch-file /audit/auth-latch.json \
  --model claude-sonnet-4-6 --concurrency 10
```

Use a new vm2api instance with `KIN_API_PASSTHROUGH=1`,
`KIN_TELEMETRY_INGRESS=reject`, `KIN_REQUEST_LOG_MODE=normal`, a dedicated
`KIN_PROJECT_ROOT`, `KIN_DATA_DIR`, `KIN_CAPTURES_DIR`, and its own DB secret.
Through its native panel API, create exactly one custom Anthropic endpoint at
`http://127.0.0.1:18786`, with the adapter key and explicit allowed models. Create
a separate API-category downstream key with `max_concurrency=10`; never use the
master key for inference. Do not copy the main gateway's routing or database.

## Activation and rollback procedure

- The operator's intended organization is authorized and native authorization remains valid.
- Actual runtime exit matches the pinned IP; DNS/direct fallback is blocked.
- Offline Node/Python and Linux candidate tests pass with no upstream access.
- One unique short JSON call and one unique SSE call complete, with usage and
      actual upstream request IDs. Save intent and receipt; do not replay on an
      ambiguous timeout or repeat a potentially charged call.
- Negative concurrency/isolation/invalid-input tests use mocks, not charged
      requests. Read-only resource and log observations show no OOM or revocation.
- Only then add a scoped HTTPS route for `/v1/messages` and `/v1/models`.
      Block panel/admin/telemetry/unknown paths, disable response buffering and
      automatic upstream retries, validate Nginx, and reload gracefully.
- Create one independent Sub2API API account, concurrency 10, shared groups,
      no user affinity, and only models verified for this binding. Keep all
      existing exclusive-account mappings and keys unchanged.
- Verify through Sub2API with a new canary and reconcile its request/usage
      records, then compare all original container/start/guard/routing invariants.
- On any native revocation stop this new chain; do not retry login, resume
      the old guest, or affect other accounts. Disable its Sub account/key before
      stopping its containers. Do not restore the whole production database.

## Persist and recover the isolated deployment

Persist a **separate** Compose definition for the native daemon, adapter and
API gateway. The adapter and gateway use `network_mode: service:runtime`.
Record exact image digests, private bind mounts and per-service resource limits.
Validate with `docker compose config --quiet`; a validation is not permission
to run `compose up/down` against the original vm2api project. The deployment
must preserve the daemon's native machine identity and private HOME.

The native exit helper runs inside the original host-network gateway. Its
reserved proxy remains disabled for ordinary VM allocation, with no bound VM.
Because the allocator will not start an unbound proxy after a host/gateway
restart, install `ensure-egress.mjs` on a directory that gateway already mounts.
Run it inside that container with the project root, proxy ID and explicit pin:

```sh
docker exec vm2api node /opt/vm2api/data/operations/reclaude-ensure-egress.mjs \
  /opt/vm2api PROXY_ID EXPECTED_IP
```

A scoped systemd timer may invoke this check once a minute. A ready/live helper
is a read-only no-op. It calls the native `ensureProxyEgress` only for an absent
helper whose last verified state matches the existing pin/revision. A latch,
changed policy, missing state, stale live monitor or failed verification requires
operator review. It never writes an allowed IP or clears a latch. All traffic
remains blocked until the native helper verifies the pinned exit again.

After a daemon-only restart the adapter rereads the dynamic loopback port from
native state. After *recreating* its network namespace, recreate only the two
relay sidecars against that namespace; do not restart any existing OAuth slots.
Before re-enabling Sub2API scheduling verify the guard, native status, adapter
health, key scope and new gateway. Disable this new Sub2API account first for a
controlled maintenance/recovery; never restore an old database or OAuth backup.

The native DNS helper has its own per-upstream timeout. Configure only the new
runtime's resolver (`use-vc timeout:10 attempts:2` in the verified deployment)
so it can wait through the helper's fallback. This is not a direct DNS fallback;
transparent DNS redirection and the bridge forwarding DROP rule remain required.

## Acceptance observations

The adapter requests identity encoding and incrementally validates/decompresses
upstream gzip with an expanded-byte limit. SSE terminal/usage observation runs
on decoded bytes; truncated, unsupported or oversized compression fails explicitly.
A prior audit-only gzip parsing bug was caught before shared activation and fixed
with four regression cases. Do not replay its already successful paid requests.

The native API-backend SSE path also lacked returned usage and recognized a
terminal by substring. It now merges actual message-start/delta usage without
buffering response text, requires a real terminal event, and preserves stream
errors. The isolated passthrough profile keeps upstream cache-TTL buckets for
billing instead of applying a panel TTL that was never sent. Four regression
cases reproduced these defects before the fix. A saved successful response was
then verified in a network-disabled candidate with byte-identical output and
matching usage/cost; historical counters were not backfilled and no paid call
was replayed. Existing OAuth gateway runtime/code remained unchanged.

The edge may separately compress non-streaming JSON (zstd in the deployment).
Acceptance tools must decode HTTP content encoding before JSON assertions.
Stored response bytes can be verified offline; a parser failure is not permission
to send a second model request. Keep raw synthetic receipts restricted and never
capture production prompts or credentials in routine diagnostics.

## Tests

```sh
python3 -m unittest discover -s integrations/reclaude/tests -v
node --test test/unit/relay-egress-bootstrap.test.mjs \
  test/unit/api-passthrough.test.mjs test/unit/api-backend.test.mjs \
  test/unit/api-endpoints.test.mjs test/unit/crs-persona.test.mjs \
  test/unit/seed-policy.test.mjs
```

Fixed egress governs the server-to-ReClaude hop only. ReClaude's subsequent
provider connection is outside this deployment's control and has not been
verified. Short successful tests would not guarantee long-term authorization
stability or eliminate suspension risk.

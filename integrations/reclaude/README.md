# Isolated ReClaude relay

An experimental **native CLI backend** is now available in
[`native_http.py`](native_http.py). It launches the actual Claude Code executable
through the official ReClaude launcher for every native session. The older
`adapter.py` path below forwards external requests directly and remains available
for comparison; it must not be mistaken for native CLI execution.

See [the native backend contract](NATIVE-CLI.md) for configuration, supported
requests, session recovery and the authorization gate. Existing OAuth slots and
their telemetry settings are not changed by either optional backend.

Shared-pool authorization stability is **not established**. Functional success and
native telemetry delivery are separate from continuing device authorization.
The latest isolated investigation found that an old native daemon could retain
revoked control-plane authorization after the account binding changed. Native
health now verifies both binding consistency and the global control plane. An
explicit official stop/login/start recovery is under observation; this is not
evidence that every provider-side revocation cause has been resolved.

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

## Verified release scope

Shared-pool admission remains suspended. The recovery on 2026-10-30 reproduced
revocation on native ReClaude v1.7.1 after ten successful upstream requests.
The next Fable attempt was rejected locally with zero upstream attempts and no
usage; it cannot explain a revocation already recorded before that attempt.
The temporary Sub2API key, group and grant were removed, while the three complete
Sub2API usage records were retained and reconciled.

An official update check then found v1.7.4. Its Linux binary passed the vendor's
SHA256 check and network-disabled version/help checks before replacing only the
isolated native runtime. The same private HOME, machine identity, pinned egress
and resource limits were retained. Official reauthorization and four new native
CLI controls (Sonnet/Haiku/Opus 5.5 and Fable 5.1) passed complete SSE and terminal
usage checks. After a native-only observation window, a separate gateway control
and an isolated Sub2API canary exercised the actual gateway-auth client. All four
models completed SSE. A two-turn Read tool exchange kept execution on the client,
returned the tool result in history, and produced the exact file contents. A new
session could not retrieve that fixture from the earlier conversation.

Nevertheless, v1.7.4 also reported `device_revoked`, about 24 minutes after the
first relay request. The provider recorded thirteen successful requests: four
native controls, three direct-relay requests and six Sub2API requests. The next
JSON contract check was rejected for revoked authorization; JSON acceptance on
this binding remains incomplete. Neither the version update nor the successful
functional checks resolved authorization stability. The account stays
unscheduled, the new authentication latch stays in place, and the temporary
canary key, group and grant were removed. Six successful Sub2API records were
reconciled against response usage, vm2api and provider records.

The eight existing Pro slots, their fixed egress, concurrency one, account scope,
Fable exclusions and container lifecycles were unchanged. The native daemon
reported no OOM or restart, and the provider quota was far below its limit.
These observations do not reveal the provider's private revocation reason or
prove that any particular model caused it. Do not keep rebinding an unchanged
request path; a new recovery needs a falsifiable compatibility change.

### Earlier acceptance and failure

A separate Linux deployment passed native authorization, fixed-egress checks,
real Claude Code SSE, and Messages JSON/SSE through a one-account Sub2API canary.
It was admitted to shared groups with concurrency 10 and no user affinity.
The original seven OAuth slots, their proxies, concurrency 1, routing, keys and
container lifecycles were preserved. The new instance is not an ordinary OAuth
slot and must not be added to that allocator.

The initial acceptance used **claude-sonnet-4-6 only**. This was a deployment
allowlist, not a relay limitation. A subsequent native model-catalog query listed
`claude-opus-5-5`, `claude-haiku-5-5`, `claude-sonnet-5-5`, and `claude-fable-5-1`.
All three 5.5 models then passed separate real Claude Code SSE requests through
Sub2API and this gateway, with matching model, session IDs, usage and costs.
The Fable request encountered a native `device_revoked` event. It did not pass
acceptance; scheduling was paused and the persistent authentication latch kept.
Catalog visibility is not proof of successful inference or continuing authorization.

A later controlled recovery installed an integrity-verified, unmodified official
Claude Code build on the bound Linux machine. Two native CLI controls succeeded,
followed by a direct gateway SSE control and four separate Sub2API SSE controls
(Sonnet/Haiku/Opus 5.5 and Fable 5.1). Each used a fresh session and one dispatch;
the four Sub2API usage records matched the actual responses. Nevertheless, the
native daemon reported another `device_revoked` about 11 seconds after the last
successful response. Fixed egress remained correct. This reproduced the stability
failure; installing the native CLI and rejecting ordinary SDK formats did not
resolve it. Timing alone does not identify Fable or telemetry as the trigger.

The operator confirmed that the second revocation was not manual. Keep this
deployment paused: a short successful request is not a sufficient admission test
for a shared pool. The native v1.7.1 state records product-specific revocations in
`identities.claude.last_error` even when the top-level error is null and the
gateway is reachable. Both health checks and dispatch must inspect that scope;
an unrelated Codex error or a transient network timeout must not latch Claude.
When that revocation is already known at startup, the adapter keeps a persistent
latch and serves 503 without dispatching, rather than exiting into a container
restart loop. Other local configuration failures still prevent startup.
The local health endpoint also persists a confirmed native revocation immediately,
without waiting for another model request. A transient missing state file reports
unhealthy but does not create an authentication latch.

### Native-client compatibility remains unresolved

The source handoff had already documented this limitation. A client using
`ANTHROPIC_BASE_URL` and gateway credentials does not send the same first-party
request identifiers or device-routed telemetry as Claude Code launched by
ReClaude. In the four captured requests, `x-client-request-id` and `x-cc-atis`
were absent before Sub2API or vm2api received them. Preserving incoming headers
cannot recover signals the caller never produced.

The native daemon had reporting enabled and no telemetry opt-out variables.
`KIN_TELEMETRY_INGRESS=reject` describes this gateway's unsupported telemetry
endpoint; it does not disable the daemon's reporting. Changing its 501 to a
success response would not deliver real telemetry. Do not populate the OAuth
environment variable with a relay key, fabricate events or signatures, or use
internal first-party overrides.

ReClaude's [device documentation](https://docs.reclaude.ai/account/devices)
identifies modified environments and reporting opt-outs as common revocation
causes. Claude Code's [gateway documentation](https://code.claude.com/docs/en/llm-gateway-connect#turn-off-traffic-outside-the-gateway-path)
explains that background traffic is outside the model gateway path. These
establish a compatibility concern, not the server-side cause of this incident.
Restore service only after the provider supports the intended relay flow or a
separately validated native-client design resolves that concern. Rebinding alone
does not resolve it. The authorization-state fix prevents further dispatch after
a known revocation; it does not prevent or reverse provider revocation.

The observed organization rejects ordinary SDK clients. The earlier tests used
real Claude Code with documented gateway authentication, but that did not make
the relay equivalent to a native client or prevent subsequent revocation.
ReClaude's [client FAQ](https://docs.reclaude.ai/help/faq) lists native Claude Code
and its official extensions, and excludes API-key-based tools. Do not infer
support for a shared Messages relay from a successful short request.
See [the native-client evaluation plan](NATIVE-CLIENT-PLAN.md) before changing
this architecture; installing a CLI alone does not change the relay data path.
The latest canary exercised client-side tools, their two-turn history and fresh
session separation. Long conversations, nonzero reasoning output and ten
simultaneous paid calls were not validated online. Concurrency 10 and rejection
of an eleventh request were tested offline; successful functional tests do not
establish long-term provider authorization.

The first server organization was manually unbound by its owner before model
use. That retired binding stays stopped. Native reauthorization selected the
operator's intended organization; no credentials were cloned from a Mac or an
old slot. Exact deployment IDs, secret paths, receipts and rollback steps belong
in the private project handoff, not this public repository.

## Behavior and boundaries

### Controlled gateway-client checks

`gateway-client.py` reuses the local project's corrected gateway-auth workflow:
an explicit stable private profile, a private key file and a clean child
environment. It runs the actual installed Claude Code executable, never copies
device identity or OAuth, and never puts a relay key into the OAuth variable.
Use the same `--state-dir` for one actual test client across distinct sessions;
do not create a new profile merely to select another model.

```sh
python3 integrations/reclaude/gateway-client.py \
  --base-url https://your-gateway.example \
  --state-dir /private/path/isolated-client \
  --key-file /private/path/gateway.key \
  -- --model claude-sonnet-5-5 --tools '' --max-turns 1 --max-budget-usd 0.15 -p 'Your new bounded test prompt'
```

Only run a new online check after the intended binding is valid and the specific
test has been authorized. This helper does not retry, reauthorize, alter a server,
invent telemetry or convert gateway mode into a native client. Review persistent
profile/project settings separately; a clean child environment alone is not proof
of complete reporting. The local historical single gateway success followed by
over three hours without revocation weakens an immediate-revocation hypothesis;
it does not establish multi-client shared-pool compatibility.

### Server behavior

- Optional `--claude-code-only` rejects known unsupported client formats locally
  with `400 unsupported_client` and zero upstream attempts. It checks one actual
  `User-Agent: claude-cli/<version>` and one `x-app: cli`; it never adds missing
  client signals. These headers are not cryptographic client attestation and do
  not establish native reporting or provider approval. Keep it enabled for this
  deployment and use Sub2API's existing Claude-Code-only groups as the first gate.
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
  --model claude-sonnet-4-6 --concurrency 10 --claude-code-only
```

`--model` is repeatable. To change an existing allowlist, first pause only this
relay's Sub2API account and drain its gateway key. Recreate only the adapter with
the desired arguments, update the independent gateway endpoint's `models` using
the native panel API, and set the same exact Sub2API `model_mapping`. Persist
the adapter command in its own Compose definition. Do not change existing OAuth
slot policies or the daemon's binding. Test the requested models before resuming;
an authentication revocation requires operator review, not an automatic rebind.

This separate API gateway has its own database and panel. Its API endpoint and
request statistics do not appear in the original OAuth gateway's VM list. Trace
the actual Sub2API base URL, gateway request ID, endpoint account, adapter audit
and native upstream request ID to verify the path.

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

### Reauthorization does not reload a foreground daemon

The official login flow can replace native credentials and reset daemon state
while the old supervised foreground daemon still runs. A successful browser
authorization or a reachable socket therefore does not prove the running process
has loaded the intended binding. For an explicitly approved, single recovery:

1. Keep only this relay unscheduled, drain its key, and save the old state and
   authentication latch privately. Verify the existing fixed-IP guard; do not
   alter its expected IP, revision or latch.
   Run the official `reclaude update --check` before selecting a candidate.
   Verify the chosen binary against its official checksum and test `version`
   and `help` without network or production mounts. Do not replace a mounted
   executable or whole shared gateway opportunistically during authorization.
2. Let the native login flow authorize the same machine and intended organization.
   Verify exactly one intended credentialed binding and the official CLI discovery
   path. Never copy another machine's OAuth, identity or profile.
3. If the foreground daemon still has stale state, stop only this relay's adapter
   and gateway, restart its native runtime once, and wait for a fresh daemon
   start timestamp, correct binding and healthy product-specific authorization.
   Start the two dependents and verify all three share the runtime's live network
   namespace. Do not restart the existing OAuth slots or global gateways.
4. Retain the old authentication latch until valid native controls and the unchanged
   exit guard have been reviewed. An operator may archive that obsolete auth latch;
   this is not an exit-guard reset and must not be automated.
5. A new revocation fails recovery even if every short model request succeeded.
   Pause scheduling, retain the new latch and receipts, remove temporary canary
   credentials, and stop further login/model attempts. Do not promote a failed
   stability test into the shared pool.

Use a unique intent and response file for **each upstream dispatch**, including
each turn of a tool test. A downstream recorder failure does not imply the
upstream call failed: reconcile the existing terminal usage before considering
another test. Never replay a consumed request. Check the actual health result
between controls and stop dependent tests after a failed gate; a command that
only prints a failure is insufficient. Passive observation must be read-only,
not periodic charged model requests.

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

A later direct acceptance tunnel disconnected before vm2api received upstream
headers. The provider completed and priced that request, while vm2api recorded
`ABORT_ERR` with no terminal usage. This known discrepancy was retained; it was
neither replayed nor guessed into a customer bill. Subsequent canary checks used
the production HTTPS path. Sub2API's existing streaming drain and its disconnect,
timeout and read-error regression tests were retained. Complete canary responses
and their ledgers reconciled, but they do not prove lossless accounting for every
transport failure before headers.

Use the downstream application's native scheduling endpoint and read back its
state before sending a canary. An HTTP success from a general account update can
ignore a field it does not support. A canary must belong only to its temporary
group until admission succeeds. Removing its key/group must preserve usage rows.

## Tests

```sh
python3 -m unittest discover -s integrations/reclaude/tests -v
node --test test/unit/relay-egress-bootstrap.test.mjs \
  test/unit/api-passthrough.test.mjs test/unit/api-stream-accounting.test.mjs \
  test/unit/api-backend.test.mjs \
  test/unit/api-endpoints.test.mjs test/unit/crs-persona.test.mjs \
  test/unit/seed-policy.test.mjs
```

Fixed egress governs the server-to-ReClaude hop only. ReClaude's subsequent
provider connection is outside this deployment's control and has not been
verified. Short successful tests would not guarantee long-term authorization
stability or eliminate suspension risk.

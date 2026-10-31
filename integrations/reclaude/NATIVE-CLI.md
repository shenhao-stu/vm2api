# Experimental native CLI backend

The optional backend accepts a bounded subset of Anthropic Messages and runs the
real Claude Code CLI through `reclaude --org <id> cli`. It keeps one native
conversation per authenticated relay key and caller session. It does not install
itself into existing OAuth slots or change their routing.

```text
Actual Claude Code or an authenticated Messages caller
  → separate vm2api API-backend instance
  → native_http.py
  → per-session native Claude Code, launched by ReClaude
  → the same machine's native ReClaude daemon
  → fixed, guarded egress
```

The implementation is experimental. API/streaming/tool/history tests have passed
in an isolated environment, but continuing authorization remains under
observation after earlier revocations. Do not admit a shared production account
on the strength of a single successful response.

## Boundaries

- Run an independently authorized native device with its own HOME, credential
  store, CA and truthful machine identity. Do not copy another machine's OAuth,
  profile or identity. Use unmodified, integrity-verified official binaries.
- Let the native launcher produce its own policy requests, client headers and
  telemetry. The backend never synthesizes reporting or acknowledgement events.
- Use a dedicated vm2api data directory, API-category key and endpoint with
  `KIN_API_PASSTHROUGH=1`. Limit retries and account switches to zero on this
  dedicated route. Ordinary OAuth slots retain their existing behavior.
- Bind the adapter to loopback by default. An explicitly supplied private address
  is allowed for an isolated container network. Put authentication, TLS and
  request limits at the ingress; keep the adapter and native daemon inaccessible
  from the public network.
- Enforce the fixed exit outside the application, with no direct fallback.
  Missing connectivity is not permission to clear an exit latch or accept a new
  address. Check two independent HTTPS IP sources from the actual namespace.

## Supported contract

`POST /v1/messages` supports JSON or SSE responses, text prompts and system
context, caller-defined tools with text results, adaptive thinking, output effort
and an explicit output-token limit. Unknown or unsupported controls are rejected
before a model dispatch or session creation, rather than silently ignored. The implementation does
not claim byte-for-byte transparent API forwarding.

Every request needs `metadata.user_id` containing a canonical session UUID, an
actual Claude Code JSON user ID with `session_id`, or the native legacy user-ID
format. A new session starts with user text. Subsequent requests must contain the
exact prior history and unchanged model/system/tool configuration. Cache-control
annotations and the equivalent text-block representation are normalized for
comparison. Arbitrary imported conversations, compaction, media inputs and
changing a session's model or configuration are currently unsupported.

Tools execute on the caller. The backend exports only the requested tool schemas
through MCP and has no server Read/Bash tool enabled. A tool result must match
the exact pending tool-call set. The tool wait is bounded; an abandoned request
does not authorize another model call.

Idle CLI processes can be reclaimed and restored through native `--resume` and
`--resume-session-at`, using the original native conversation and a verified
history hash. Failed or unfinished turns are never replayed. Invalid new input
does not destroy an otherwise healthy conversation. Configuration and histories
are not interchangeable across sessions.

The key scopes a caller session namespace; a shared key is not a downstream user
identity. Trusted ingress must authenticate people and keep their session IDs
separate. UUIDs and history equality prevent accidental reuse, but are not a
substitute for an authenticated per-user security boundary. Native conversation
files contain private context: retain them only in a restricted encrypted or
otherwise protected state directory, with an explicit retention policy.

## One dispatch per accepted turn

The small Go transport uses the native device's own CA locally and forwards to
the native loopback proxy. Before `/v1/messages`, it atomically consumes an
expiring grant bound to that native session and model. Repeated CLI retries,
output-limit recovery or tool-timeout follow-ups cannot spend a second grant.
No non-streaming fallback is used. A consumed or uncertain dispatch is not safe
to repeat.

If a grant was consumed before an HTTP response could start, an incomplete turn
returns `400 native_request_consumed_no_replay`, retaining its original cause in
the audit. Other inadmissible session continuations also return 400. Returning a
5xx would allow an upstream account pool to send the same paid turn elsewhere;
409 is also retried by some SDKs and remapped by some gateways. A missing final
usage record stays unknown and must be reconciled, never guessed or replayed.

The transport also corrects invalid no-body response framing (for example,
`304` plus a chunk terminator) observed in the native proxy. It does not modify
policy contents, request identity, authorization, telemetry or model data.

SSE is complete only after a genuine terminal event. JSON is returned only after
the complete native message. On caller disconnect the adapter drains the bounded
in-flight response and audits its final usage; it does not replay the request.
The dedicated passthrough gateway also drains that response, records cancellation as
499 and charges the observed terminal usage once. A deadline or missing terminal
is recorded as cancelled_incomplete, without inventing final usage. Ordinary API
routes retain their existing cancellation policy. Reconcile caller, adapter,
vm2api and provider records before asserting downstream billing correctness.

## Native authorization health

The account credentials, `claude/current` and daemon binding set must agree with
the configured device. The daemon and account gateway must be healthy with
native reporting enabled. Health also detects global `intercept sync`
authorization errors, which can otherwise be hidden by a healthy account gateway.
Log timestamps assume this native runtime is launched with `TZ=UTC`.

A confirmed revocation creates a persistent authentication latch. Restarting the
HTTP server does not remove it. Readiness errors such as a temporarily missing
state file stop dispatch but do not invent a revocation. There is no automatic
login, rebind or latch clearing.

For an explicitly authorized recovery, preserve evidence, stop the independent
native service, complete official authorization and start it again. Verify the
new daemon and global control state, original egress and official device status
before manually retiring the superseded authentication latch. Never apply this
procedure to an unrelated active device. This fixes a demonstrated stale-daemon
condition; it does not reveal the provider's private revocation rules.

## Build and run

Use Python 3.11+ and Go 1.23+; runtime Python modules use the standard library.
Build on the target architecture, or set Go's normal cross-compilation variables:

```sh
cd integrations/reclaude/native-dispatch-proxy
go build -trimpath -o /private/bin/native-dispatch-proxy .
```

After official native authorization and fixed-egress validation:

```sh
python3 integrations/reclaude/native_http.py \
  --home /private/native-home --root /private/relay-state \
  --key-file /private/relay.key --dispatch-proxy /private/bin/native-dispatch-proxy \
  --reclaude /private/bin/reclaude --binding DEVICE_ID --org ORGANIZATION_ID \
  --concurrency 1 --model claude-sonnet-5-5
```

The relay key must be a private file (0600 or stricter), at least 32 ASCII
characters. The runtime must make the official Claude Code binary available to
the native launcher. Model availability comes from the actual subscription;
listing a model is not proof that the device can use it.

Concurrency is bounded at 1–10 native sessions. Begin at one; measure the real
runtime and tools before raising it. An isolated ten-CLI fixture measured about
1.12 GiB and 154 processes; that is not a live-workload memory guarantee. Use
container memory/PID/CPU limits and retain host headroom for other accounts.

For a finite canary, additionally use `--max-requests`,
`--session-budget-usd` and `--proof-file`. The optional proof is a fresh operator
observation with `observed_at_ms`, successful official `quota`/`devices` responses,
an active matching binding and at least 0.60 remaining quota. It expires after
120 seconds and is not polled by the backend. Do not use paid requests as health
checks. A CLI budget is an additional guard, not an exact purchase-price quote.

## Regression checks

```sh
PYTHONPATH=integrations/reclaude python3 -m unittest discover \
  -s integrations/reclaude/tests -v
cd integrations/reclaude/native-dispatch-proxy
go test -race ./...
```

Set `NATIVE_CLI` to an unmodified executable to include the real-CLI output-limit
test. Run actual-CLI fixture suites in a network-disabled lab with synthetic
credentials. Live acceptance is separate: fresh intent, valid official quota,
fixed exit, real client tool/history/isolation, cancellation/terminal usage,
four-way accounting and a meaningful authorization observation window. A provider
`stop_reason: "refusal"` is a terminal response, not a missing stream or a device
revocation: preserve it and its usage without automatic fallback. Record transport
completion separately from a normal-output acceptance assertion. Keep the
production account paused until the applicable gates pass.

## Cold-start latency

Keep native authorization and policy readiness checks in the request path. An
optional [private DNS cache](dns-cache/README.md) can reduce repeated DNS round
trips using the existing guarded helper, without changing the model backend or
sharing CLI context between conversations. Its deployment requires no relay or
OAuth-slot restart. DNS readiness timings alone do not establish end-to-end
first-token improvement.

### Explicit session preparation

The private native backend can opt in to `--allow-prewarm`. It then accepts an
authenticated `POST /v1/messages/prepare` with the same validated Messages body
and caller session ID as the intended first request. It launches that session's
native CLI, waits for the real policy and native `initialize` acknowledgement,
and returns JSON such as:

```json
{"ready":true,"reused":false,"model_dispatches":0,"idle_ttl_seconds":120}
```

The preparation request does not submit its user messages, create a model grant,
append conversation history, or consume the operator's model-request budget.
Send the actual prompt separately to `/v1/messages`. Model, system context,
tools, output limit and other launch configuration must remain identical; user
text can change before the first real turn. Each process belongs to exactly one
authenticated key and caller session. Existing conversations still require
their verified history. No prepared process is reassigned to a different
conversation, and no native authorization or telemetry is synthesized.

Preparation uses the same concurrency gate and bounded session pool as inference.
An unused prepared CLI expires after 120 seconds (or the shorter normal idle
limit), checked by the existing 30-second reaper. Actual conversations retain the
configured normal idle limit. Closing CLIs remain counted until exit, while
unrelated sessions can continue without waiting under the pool lock. Only a
checkpoint explicitly recorded as never dispatched may restart empty after
expiration; consumed, failed or uncertain turns retain no-replay protections.

The native control handshake follows the official SDK's
[streaming-input initialization](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py).
Normal multi-turn reuse follows the native
[persistent streaming-input session](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).
The preparation endpoint is a backend extension, not part of Anthropic Messages:
the ordinary vm2api/Sub2API route does not automatically call or forward it.
Keep it private behind the same authentication and network restrictions. A
trusted caller integration must prepare the actual session while the user is
still composing input; adding preparation immediately before an awaited request
only moves the same cold-start delay. A new Sub2API account test intentionally
creates a new UUID and therefore remains a cold-session measurement.

Audit records distinguish `operation=prepare` from `messages`, report native
CLI reuse and pool lease time, and timestamp the first non-empty text delta.
Handshake bytes and readiness responses are never reported as model first tokens.

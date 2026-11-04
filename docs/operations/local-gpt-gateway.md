# Optional local GPT gateway

This integration takes the reviewed API boundary from `dev/hosted` without adopting its independent deployment defaults. It is inactive until an administrator creates both a `local_gateway` API endpoint and a managed `hybrid`/`openai` key explicitly bound to that endpoint. Existing OAuth/API keys, Claude kernels, Pro slots and ReClaude policies are unchanged.

## Setup

1. Deploy the GPT backend separately. For a remote c2a backend, expose its authenticated API through a restricted private tunnel bound to a numeric loopback address on the vm2api host. Do not open the backend port publicly. The tunnel is an operator-controlled transport, not created automatically here.
2. In API endpoints choose **本机 GPT 网关**, enter the loopback origin (no `/v1` suffix), upstream bearer credential, and the explicit approved GPT model names/aliases. Example addresses in tests are not production defaults.
3. In Key settings choose **GPT 本机网关** and select that endpoint. This key has no native VM/pool scope. Set concurrency/quota deliberately; existing defaults have not been changed. Give the independent key to the intended caller.
4. Use `/v1/responses`, `/v1/chat/completions`, `/v1/completions` or `/v1/messages`. `/v1/models` exposes only that key's explicit gateway catalog. An absent/disabled endpoint fails closed, never falling back to a Claude, ReClaude or native Codex slot.

## Enabled contract

- Responses is the upstream wire protocol. JSON and SSE are supported without replay or nonstream fallback.
- Chat, Completions and Messages convert to Responses; standard function tools and tool history, ordinary multi-turn text, token limits, temperature/top_p, metadata, prompt-cache key and JSON-schema text format are preserved where representable. Chat accepts user image URLs. Messages accepts text and standard tool use/results; it rejects other block types before dispatch.
- Responses preserves complete input/history and custom tools. Server-side history references (`previous_response_id`, `conversation`, `item_reference`) and image-generation tools are explicitly rejected. The gateway does not retain server-side conversation history. Callers must supply full history for each turn.
- Only the standard service tier (`default`, `standard`, or omitted) is enabled. Other tiers are rejected before dispatch. Only models with a known local pricing rule are dispatched.
- SSE requires visible output, a completed terminal and authoritative final input/output usage. Missing, incomplete, malformed or reasoning-only completion is not reported as successful.

## Accounting and failures

A completed 2xx upstream response with final input/output usage is charged once using existing pricing/group rates even if downstream conversion fails. Delivery success is not billing evidence. A missing final usage receipt is not replaced with zeros. If an upstream returns an unexpected model/tier that cannot be priced, the request is marked `billing_pending`, its observed usage and null cost remain in logs, and it is not silently recorded as a free successful request. Such abnormal upstream evidence needs operator reconciliation; the adapter cannot infer an unknown price or recover usage the upstream never supplied. Never replay the request to recover its receipt.

Client cancellation destroys the one upstream request and releases its key admission. Other keys and slots are unaffected. Per-endpoint 429 cooling applies only to the selected credential; it does not try another backend.

## Security and compatibility boundary

Only numeric loopback HTTP(S) origins are accepted; redirects, DNS hostnames, embedded credentials, paths/query fragments, custom headers and per-key proxy overrides are rejected. Caller session/thread/parent/turn metadata headers are not forwarded. `prompt_cache_key` remains a performance hint and grants no permission to read stored content. Caller credentials/cookies are not forwarded; the selected endpoint credential replaces authentication. Ordinary API keys cannot select these endpoints. Tenant users cannot create or broaden platform gateway bindings. Each configured backend must itself enforce its upstream-account and session policies.

This change does **not** activate native Codex, `/v1/images/generations`, `/v1/images/edits`, new image kernels, model account migration, or the hosted Claude payload. GPT image models and image generation tools are explicitly unavailable in this gateway. Those capabilities need a separate c2a/native-Codex deployment and billing/protocol review. ReClaude Fable support and per-Pro Fable denials remain governed by their existing scoped policies; there is no new global Fable ban.

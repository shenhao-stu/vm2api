# Hosted console under a shared domain

`dev/hosted` serves an independent Claude workspace beside the existing GPT service.
The GPT application and its original API credentials stay unchanged.

| Entry | Owner | API credentials |
| --- | --- | --- |
| `https://storyboardbook.cn/codex` | Existing GPT console | Original GPT service |
| `https://storyboardbook.cn/v1` | Existing GPT API | Original GPT Key |
| `https://storyboardbook.cn/claude/` | Hosted workspace | Panel login |
| `https://storyboardbook.cn/claude/v1` | Hosted API | Separate hosted Claude and GPT pool Keys |

`/` redirects to `/codex`. `/cc` redirects to `/codex`; the proxy maps the new
console URL to the existing backend's `/cc` internally. Its root `/assets` and
`/api/panel` routes continue to reach the existing GPT backend.

The hosted proxy strips `/claude/`, sends requests to its own loopback listener,
and overwrites `X-Forwarded-Prefix` with `/claude`. Set
`VM2API_PUBLIC_BASE_PATH=/claude` on that instance. The backend accepts the prefix
only when it exactly matches this configuration. Direct IP access clears the
header and retains the existing `/console` and `/v1` endpoints.

Set `proxy_request_buffering off` with `proxy_http_version 1.1` on both hosted
locations (the domain prefix and dedicated IP). This streams uploaded bodies
to the gateway, including chunked uploads, without depending on Nginx's body
temporary directory. `proxy_buffering off` controls responses only. Keep the
128 MiB body limit and the gateway's existing admission checks. Do not apply
this change to the original GPT locations. The isolated Linux/root regression
check is `python3 test/ops/hosted-nginx-body.py`; it makes no provider calls.

HTML assets, API calls, event streams, terminal WebSockets, and generated client
examples use the same runtime mount. A relative Vite build serves both mounted
and legacy entries. Hash navigation preserves the document path. Panel storage
is scoped by cookie name and mount; the hosted cookie uses its own name and
`Path=/claude`. Matching administrator credentials do not create shared sessions.

For Anthropic SDKs and Claude Code, set
`ANTHROPIC_BASE_URL=https://storyboardbook.cn/claude`; the client adds
`/v1/messages`. Direct HTTP calls use `/claude/v1/messages`.
OpenAI-compatible clients use `base_url=https://storyboardbook.cn/claude/v1`.
To tolerate an Anthropic client configured with that OpenAI-style URL, include
`deploy/hosted-prefix-compat.conf` inside the existing `/claude/` proxy location.
It internally maps the duplicated `/claude/v1/v1/` prefix for Messages, token
counting, Chat Completions and Models to the same Claude upstream. It does not
redirect POST requests or change the root GPT routes. Run
`python3 test/ops/hosted-nginx-prefix.py` on Linux to verify body, authorization,
query preservation and GPT isolation before reloading Nginx.
The original GPT Key remains on `/v1`; it is not interchangeable with Keys
issued by the hosted workspace. Neither route changes the Fable deny policy.

Before replacing the hosted gateway, temporarily disable its active business
Keys to close admission, pause its schedulable slots, and wait for in-flight
requests to drain. Preserve exact prior Key and slot states. Back up the
database and runtime configuration, replace only the hosted gateway, verify
fixed exit IPs, and explicitly restore healthy slots and prior Key states.
Keep the existing GPT container running throughout. Validate Nginx before
reloading and check both API paths, cookie isolation, streaming completion,
actual terminal usage, and logs after the change.

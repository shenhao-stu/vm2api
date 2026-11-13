# Native Relay request body budget

The native HTTP process defaults to 8 MiB. An explicit `--max-body-mib 16`
permits at most 16 MiB; accepted values are integer MiB from 1 to 32.
`server.ready.safe.json.max_body_bytes` records the effective limit.
This controls serialized HTTP bytes, not model context size, account quota or
session concurrency. It does not change any existing instance by default.

Keep all three ingress limits consistent when enabling a larger budget:

1. The two exact ReClaude messages locations in nginx: `client_max_body_size 16m`.
2. Each isolated API gateway: `KIN_MAX_BODY=16777216`. Confirm the native
   routing limit does not impose a smaller ceiling; preserve every other field.
3. Each native HTTP service: `--max-body-mib 16`.

Retain nginx request buffering, existing private ingress ACLs and API
authentication. The native reader requires one Content-Length, rejects values
above the configured limit before reading, and verifies the actual read length.
Chunked requests are buffered at nginx before forwarding. The HTTP API requires
a complete JSON value, so disabling buffering does not remove JSON memory use.

For the existing 512 MiB API gateways, enforce both limits **before body
parsing** at nginx: at most ten in-flight requests and two large requests per
Relay URI. The native CLI concurrency limit alone cannot constrain gateway
memory: the gateway reads JSON before acquiring its managed-key seat.

Use the three fragments under `integrations/reclaude/nginx/`:

- `admission-http.conf` in the nginx `http` context defines the two zones.
- `admission-location.conf` in each exact Relay messages location sets the
  16 MiB limit, total-ten and large-two budgets. It also preserves the existing
  `vm2api_clients_direct 20` limit: location-level limits override inheritance.
- `capacity-server.conf` in that server returns local capacity failures as JSON
  429 (`native_ingress_busy`) with `Retry-After: 1`.

A known Content-Length below 1,000,000 bytes is small. All other requests,
including unknown/chunked lengths and GET bodies, consume a large seat.
The normalized URI identifies the Relay; query strings and client IP headers
cannot obtain extra seats. Do not attach these limits to Pro locations.
`proxy_intercept_errors off` preserves an upstream quota 429 and its reset
headers. Capacity rejection occurs before forwarding or model dispatch.
Sub2API currently applies its default five-second account backoff to such a
429; the header does not guarantee a one-second or single-seat-only backoff.

Verify the ingress boundary before relying on this memory budget. Current
production uses Netcup's private Caddy listener 19878 → loopback SSH bridge
19877 → HappySrv nginx 18888 → the two exact Relay messages locations.
The SSH account permits only 127.0.0.1:18888, and both host-network gateway
processes listen on 127.0.0.1 only. Other Relay paths return 404. Host-local
administrative access remains trusted and can bypass nginx; do not route
business traffic or load probes directly to the gateway ports.

Run `python3 integrations/reclaude/tests/nginx_admission_probe.py` on a host
with nginx installed. It starts a separate nginx on an ephemeral loopback port
and a local fixture upstream, then removes both. It covers admission before
body upload, ten-plus-one and large-plus-one rejection, unknown lengths,
method/query/encoded-URI boundaries, independent Relays, retained Pro limits,
JSON capacity errors and unchanged upstream quota responses.

The isolated production-image probe with the existing 384 MiB Node heap and
512 MiB cgroup, a retained 100 MiB baseline, two 16 MiB JSON requests and eight
999,999-byte requests peaked at 323,624,960 cgroup bytes (2026-11-12). It used the image's
actual body reader, sanitizer and serialization, with no network or credentials.
This is evidence for that synthetic workload, not a bound for every JSON shape.
Real client body structure was unavailable and no customer request was replayed.

A change only to these nginx admission fragments can use `nginx -t` and a
graceful nginx reload; preserve the main gateway and native Relay lifecycles.
For gateway/native body-limit changes, drain each independent Relay in turn. Keep its native
daemon, device, guard, fixed IP, API keys and account/session state unchanged.
Preserve existing gateway image and source overlays. Do not clear failed
session checkpoints to make a request pass. A body-limit change does not
resolve an upstream quota rejection or authorize replaying a consumed turn.

## Queue pressure and upstream cooldown

A confirmed local `pool_overloaded` response before any dispatch is admission
pressure, not evidence that every account in an aggregate pool is overloaded.
Sub2API g90 distinguishes the structured 529 response and keeps the pool eligible
for later requests. It retains real upstream 529 cooldowns, unknown/dispatched
errors and explicit administrator policies. This does not override account
quotas, authentication or fixed-exit latches. Session-busy 429 handling is separate.

Two large in-flight requests remains a bounded memory policy, not a guarantee
that no burst will be rejected. Keep actual native execution at its tested ten
concurrent sessions until higher capacity is verified together with the gateway,
CLI pool, memory budget and downstream account limit. Do not force a new account
for an existing conversation just to raise priority or obtain a free seat.

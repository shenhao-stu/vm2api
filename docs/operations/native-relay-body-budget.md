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
parsing** at nginx: at most ten in-flight requests and one large request per
Relay URI. The native CLI concurrency limit alone cannot constrain gateway
memory: the gateway reads JSON before acquiring its managed-key seat.

Use the three fragments under `integrations/reclaude/nginx/`:

- `admission-http.conf` in the nginx `http` context defines the two zones.
- `admission-location.conf` in each exact Relay messages location sets the
  16 MiB limit, total-ten and large-one budgets. It also preserves the existing
  `vm2api_clients_direct 20` limit: location-level limits override inheritance.
- `capacity-server.conf` in that server returns local capacity failures as JSON
  429 (`native_ingress_busy`) with `Retry-After: 1`.

A known Content-Length below 1,000,000 bytes is small. All other requests,
including unknown/chunked lengths and GET bodies, consume the large seat.
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
512 MiB cgroup, a retained 100 MiB baseline, one 16 MiB JSON request and nine
999,999-byte requests peaked at 323,383,296 cgroup bytes. It used the image's
actual body reader, sanitizer and serialization, with no network or credentials.
This is evidence for that synthetic workload, not a bound for every JSON shape.
Real client body structure was unavailable and no customer request was replayed.

Roll out only after draining each independent Relay in turn. Keep its native
daemon, device, guard, fixed IP, API keys and account/session state unchanged.
Preserve existing gateway image and source overlays. Do not clear failed
session checkpoints to make a request pass. A body-limit change does not
resolve an upstream quota rejection or authorize replaying a consumed turn.

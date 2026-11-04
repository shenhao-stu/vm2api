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

For the existing 512 MiB API gateways, use a separate native nginx admission
budget for ReClaude. Requests of at least 1,000,000 bytes, or unknown length,
share one large-request seat per Relay URI. Smaller requests retain their
existing concurrency limit of 10. Do not attach this zone to Pro locations.

```nginx
map "$request_method:$http_content_length" $reclaude_large_body {
    default $uri;
    ~^(GET|HEAD|OPTIONS): "";
    "~^[A-Z]+:[0-9]{1,6}$" "";
}
limit_conn_zone $reclaude_large_body zone=reclaude_large_requests:1m;
```

In each exact ReClaude messages location, preserve its existing configuration
and add `limit_conn reclaude_large_requests 1` and `limit_conn_status 429`.
The URI identifies the Relay; caller-controlled IP headers cannot obtain an
extra seat. The concurrency rejection happens before dispatch and differs from
an upstream model limit or an already-consumed request.

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

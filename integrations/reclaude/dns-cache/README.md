# Optional private DNS cache

Use the node's existing dnsmasq package to cache DNS for one isolated native
ReClaude network. This reduces repeated DNS round trips during launcher/account
sync and CLI startup. It does not bypass native authorization, policy checks,
telemetry, the pinned exit guard, or per-session CLI isolation. No model, OAuth,
proxy credential, or conversation data is cached here.

The example listens only on loopback and the selected private bridge. Its sole
upstream is that network's **existing guarded DNS helper**, not a public resolver.
No `/etc/resolv.conf` or `/etc/hosts` fallback is enabled. The 256-entry cache
honors shorter authoritative TTLs and caps storage and client TTL at 60 seconds.
Zero-TTL answers and failures are not cached. See the
[dnsmasq manual](https://thekelleys.org.uk/dnsmasq/docs/dnsmasq-man.html).

## Deploy without restarting the relay

Review all example addresses and ports against the actual isolated network.
The systemd unit runs as the distribution's `dnsmasq` user with no capabilities,
a read-only filesystem, inaccessible user homes, and a 64 MiB memory ceiling.
It does not enable itself on boot or start/rebind a model account.

1. Verify the original native device, guard revision, pinned IP, account limits,
   active requests, and unrelated service baselines. Keep a scoped route backup.
2. Restrict TCP/UDP cache-port input to loopback and the intended container's
   source IP **and bridge interface**; reject all other sources. Confirm the port
   is unused. Install the config at `/etc/vm2api/reclaude-dns-cache.conf` and the
   unit at `/etc/systemd/system/reclaude-dns-cache.service`.
3. Run `dnsmasq --test` and `systemd-analyze verify` on those files. Start only the
   new cache service. `systemctl start` for `Type=simple` is not a readiness check:
   wait for its listener, then verify successful TCP and UDP DNS responses from
   the real native container. Check cache hits, TTL expiry, and failure behavior.
4. Change only the isolated bridge's existing TCP/UDP DNS redirects to the cache
   port. Leave its generic TCP redirect, external-forward DROP, guarded helper,
   guard state, native daemon, and all other slot rules untouched. Existing DNS
   connections can finish through the previous helper while new ones use cache.
5. Recheck the actual exit with two independent HTTPS sources, public access
   controls, native authorization, resource limits, and original slot identities.
   Measure genuine CLI readiness without input or a dispatch grant before any
   separately authorized new paid acceptance. Never replay a consumed request.

Do not restore an entire firewall snapshot: unrelated rules and counters can
change concurrently. If the network is rebuilt, recheck the DNS redirects; the
original helper's network setup may restore its own DNS port. Reapply this
optional layer only after checking that same helper and original exit guard.

## Rollback and failure behavior

Restore only the two DNS redirects to the original guarded helper, then stop the
cache service. Remove only this cache's input jumps/chain after verifying that
nothing references them. Never remove the native network's external-forward
DROP or reset the exit guard. A stopped cache with redirects still targeting it
fails DNS resolution; it does not fall back to a direct or alternative proxy.
Cached DNS answers cannot reopen a connection closed by the exit guard.

## Measurement limits

A controlled native TCP-DNS comparison on 2026-10-31 showed cache hits around
1–2 ms versus uncached queries around 270–540 ms. A loopback-only fixture verified
short TTL expiry, zero-TTL and SERVFAIL behavior, and the 60-second cap. These are
DNS measurements, not complete model first-token measurements. Native launcher
sync, required policy reads, proxy latency and provider generation still add
latency. Retain the same authenticated tenant/session identifier for a real
conversation to reuse its existing CLI; never reuse another conversation's
context to improve timing.

A separate per-CLI TLS-reuse candidate passed functional fixtures but did not
show a repeatable overall readiness improvement in live A/B samples. It was not
included in this deployment.

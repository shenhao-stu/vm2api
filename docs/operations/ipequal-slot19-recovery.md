# IPEqual A ingress recovery (2026-11-11)

The subscription's `.40:5389` entry failed TLS while another entry returned the authorized exit `48.47.12.9`. The initially verified `.42` entry subsequently failed too. Fresh probes found `.39` and `.41` healthy; the final deployment uses `.41`, validated through two independent HTTPS services from all five affected slots. No exit-IP change or OAuth revocation was involved. TLS certificate validation remains enabled.

Slots 01/05 retain their proxy records and authenticated listeners in `vm2api-ipequal-a-pro-recovery`. Slots 08/14/19 use separate authenticated loopback listeners in `vm2api-ipequal-a-slot19-ingress`, with native proxy records `px-48fa979e`, `px-1b0683c5` and `px-7e9395e4`. Each has its own guard and isolated slot network. Accounts, VM/HOME, Keys and concurrency1 remain unchanged; the pool-wide one-slot-per-proxy limit stays1. The old managed `.40` proxy for slot19 is unbound and disabled.

The added entry service has a 96 MiB memory ceiling, read-only root and no capabilities. Restricted configuration lives under `/opt/vm2api/ops/ipequal-a-slot19-20261111/`; no provider credentials belong in Git. Slots 08/14 were individually drained and reloaded for their new bindings. The two entry services were restarted during this authorized repair; unrelated containers were not restarted.

These pinned listeners do not follow subscription labels or refreshes automatically. Review the actual node configuration when provider authentication or ingress changes. Subscription mirror fallback only changes the download source; it does not authorize a new exit or clear a latch.

Default Docker address pools were exhausted. Three `/28` networks (`10.244.252.0/28`, `.16/28`, `.32/28`) were checked against Docker networks and host routes before use. This allocation issue did not require disabling the egress guard.

Final checks at 16:47 UTC confirmed all14 native slots ready at their original exits, 13 Pro with concurrency1 and Max5x with concurrency5. The two retired slots remained stopped. The provider had failed twice during the maintenance window: successful recovery is not evidence of permanent provider stability. Existing guards still block failed verification; there is no automatic IP acceptance.

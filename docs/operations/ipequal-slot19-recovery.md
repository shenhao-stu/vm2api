# Slot 19 ingress recovery (2026-11-11)

The IPEqual A `.40:5389` entry failed TLS while `.42:5389` returned the authorized exit `48.47.12.9` from two independent HTTPS services. The fix changes the ingress, not the authorized exit or account authorization. TLS certificate validation remains enabled.

Slot 19 uses an independent authenticated loopback Mihomo listener (`vm2api-ipequal-a-slot19-ingress`, 96 MiB memory ceiling, read-only root, no capabilities), a separate native proxy record `px-7e9395e4` and native exit guard. It retains its original account, VM/HOME, Key, session scope and concurrency1. The pool-wide one-slot-per-proxy limit stays1. The former `.40` managed proxy is unbound and disabled.

The pinned snapshot is drawn from the validated IPEqual A `.42` node configuration. Its restricted runtime configuration is under `/opt/vm2api/ops/ipequal-a-slot19-20261111/`; no provider credentials belong in Git. This isolated listener is not automatically changed by a subscription refresh: review its source configuration when the provider changes authentication. Existing mirror refreshes do not authorize a different exit or clear a latch.

During maintenance preflight the same `.40` failure was found behind U134 slot05. Its existing entry service now sends that listener through `.42`; slot01's listener, both native proxy records, Key scopes and guard revisions were retained. Both accounts were drained before the entry service restarted and were restored after fresh dual-source verification and native diagnosis.

Default Docker address pools were exhausted when provisioning the new helper. A non-overlapping `/28` was verified against Docker networks and host routes before creation. This is a host allocation issue, not a reason to disable the egress guard.

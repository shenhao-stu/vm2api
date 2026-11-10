# IPv4-only cluster slot DNS

A Docker guest with `EnableIPv6=false` still asks for A and AAAA. The transparent resolver forwards TCP DNS frames serially; an unnecessary AAAA lookup can exceed libc’s overall wait when the bound proxy has slow DoH or broken TCP/53. Curl may report `Could not resolve host` even though the same guarded path reaches upstream with `-4`.

Use the existing kin-egress `dns_empty_types:[28]` option on verified IPv4-only slot networks. Remote slot preparation reads the actual Docker network flag. IPv6-enabled and unknown networks keep normal AAAA resolution; existing SVCB/HTTPS overrides are retained. All remaining DNS stays behind the same guarded SOCKS proxy. No direct fallback, exit unlock, CLI/kernel update, or account-tier change is required.

DoH also needs a bounded idle lifetime. A bound proxy can silently expire an idle TCP tunnel while the HTTP transport still considers it reusable. The egress helper closes idle DoH connections after 20 seconds, while reusing warm connections and leaving active requests alone. This affects DNS only; model transport, account credentials, guards, and CLI payloads are unchanged.

For a live incident, drain only the affected account in both routing layers, verify no inflight work, back up its config, and restart only its egress helper after changing the native option or installing a tested egress binary. Keep a hash-verified backup of both. Verify two exit sources from the actual guest, guarded HTTPS, DNS timings, unchanged guest/container identities, and a new bounded model stream with terminal usage. Never replay an unknown request. A helper config hotfix does not authorize a main gateway restart or other exit rearming.

Do not infer a permanent fix from one healthy cold probe. Capture multiple non-model samples, a probe after at least 65 seconds idle, and natural traffic. A successful cold probe does not prove an idle connection remains usable. Distinguish fresh-helper effects from reduced DNS work. Ensure future image/recreation includes the network-aware config policy, since an older controller may overwrite manual config when replacing a helper.

The motivating production account is **slot 20, Claude Max 5x**. “20” is its slot number, not a Max20x plan.

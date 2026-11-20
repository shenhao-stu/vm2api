# Runtime source revisions

The Claude gateway, Codex controller, ReClaude integration, and unified console are built independently. Use the pinned Git revisions to reproduce the application sources for this release.

| Component | Source revision |
| --- | --- |
| Claude gateway | `10165c9dd4c903e57cd6c3db8b1fca587052a851`, with the module revisions below |
| Codex controller | `d040fb614b732a2d96405c9481aa43b65dcddcf3`, with the module revisions below |
| ReClaude integration and admission templates | `1f80817383505d8881e427e46d44d1576ab1e124` |
| Unified console | `149f84d2951d86c73c57e93313245b6ca7f1a7db` |

For the Claude gateway, use these revisions for the corresponding modules.

| Path | Source revision |
| --- | --- |
| `src/lib/cluster/remote-slot.mjs` | `2912ab275a0aaf6d37ca8741cf38ec7f4b6511e4` |
| `src/lib/protocol/codex-convert.mjs` | `193fb4d48531e43725609e63d72f0105f337eda2` |
| `src/lib/protocol/native-relay-error.mjs` | `6667739b28886c0a29469a4c8bf16ab4c6a27675` |

For the Codex controller, restore the following modules from `2a4cb0a3066523d2bf5962b2ec048a1787734e68` into a separate checkout of its base revision.

- `src/lib/admin/codex-quality.mjs`
- `src/lib/admin/quality-probe.mjs`
- `src/lib/protocol/codex-convert.mjs`
- `src/lib/protocol/codex-safety.mjs`
- `src/lib/protocol/handle-codex.mjs`

Build the static console using the [unified console release guide](unified-console-release.md). Supply deployment values through the target environment's private provisioning process.

## Changes after this release that are not yet in every runtime

The table above describes the published gateway images. Later commits on `main` reach a runtime only when its own release procedure loads them.

| Change | Commit | Loaded by |
| --- | --- | --- |
| Identical relay requests are answered again from the completed turn | `d183b18d` | The native Relay HTTP workers, since 2026-11-20. They keep their pinned `native_http.py` base and carry the same edit together with `native_reply_cache.py`. |
| Policy confirmation stops waiting once the CLI reports a stale cache | `99ad4a8d` | The native Relay HTTP workers, since 2026-11-20, released together with the launch pause below. |
| New launches pause after the provider leaves policy unconfirmed | `4324ecda` | The native Relay HTTP workers, since 2026-11-20. Released with the stale-cache change because that change alone shortens the interval between failed launches. |
| Relay sessions recover after switching accounts | `5d36a9ef` | The native Relay HTTP workers, since 2026-11-19. |
| Enrolled native devices appear before inference admission | `ae795e07` | The Relay management service, since 2026-11-19. |
| Upstream fixes: egress DNS cache, atomic credential symlinks, 429 instead of 502 when every account is rate limited, refusal details in diagnostics | `b6024028`, `3e3680d5`, `70f9183e`, `55003e26` | No runtime yet. They need a gateway image rebuild and a guarded restart. |

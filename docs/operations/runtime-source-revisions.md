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
| Upstream fixes: atomic credential symlinks, 429 instead of 502 when every account is rate limited, refusal details in diagnostics | `3e3680d5`, `70f9183e`, `55003e26` | The Claude gateway, since 2026-11-20, as a file overlay on the running image. |
| Upstream fix: egress DNS cache | `b6024028` | The Claude gateway's Go egress worker, since 2026-11-20, from a reproducible rebuild of `1611cb7a` published as a new image layer over the running one. |
| "keygen" blocks only next to cracking words | `f05df3f5` | The Claude gateway, since 2026-11-20: first as saved intercept rules through the panel API, then as the built-in rule in the same file overlay. |
| Upstream Codex fixes: image input, ultra reasoning, namespaced tool choice, catalog fallback version | branch `port/codex-upstream-20261120` at `e1a47026`, based on `c27c22c7` | The Codex controller, since 2026-11-20, as six files layered over its running image. The outbound client version in its routing configuration was raised to 0.167.1 at the same time; that is configuration, not source. |
| A Relay whose seat quota is used up is paused and resumed after the reset | `c0d21696` | The Relay management service, since 2026-11-20. |
| Local admission 429s no longer cool the Relay gateway's only key | `4d0d0b95` | The 33871 Relay gateway since 2026-11-17, and the three seat Relay gateways since 2026-11-21. Each mounts this commit's `src/lib/pool/api-protocol.mjs` over its image; the two protocol files beside it stay at the revisions in the table above. The seat gateways also set `KIN_RATE_CAP=600` and `KIN_RATE_REFILL=20`, which is environment, not source. |
| An identical request is dispatched again after an unbilled gateway refusal | `c7c257d6` | The three seat Relay HTTP workers, since 2026-11-21. They keep their pinned `native_http.py` base and carry the same edit; `adapter.py`, `native_channel_store.py` and `native_terminal_error.py` are this commit's files. |
| A conversation whose CLI is already running is served while launches are paused | `96c4a560` | The three seat Relay HTTP workers, since 2026-11-21. `native_session_pool.py` is this commit's file; `native_http.py` carries the same edit on its pinned base, using the server's tenant where this commit uses the authenticated one. |
| A busy conversation's next turn, or a new one on a full relay, waits up to 45 seconds instead of being refused | `0e6c6326` | The three seat Relay HTTP workers, since 2026-11-21 13:49–13:51 CST. `native_http.py` carries the same edit on its pinned base, using the server's tenant and pool lease where this commit uses the authenticated tenant and `lease_session`. |

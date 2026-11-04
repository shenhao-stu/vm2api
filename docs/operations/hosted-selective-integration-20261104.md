# Selective hosted integration — 2026-11-04

This release uses fork main `9343ccaf` as the Claude baseline and reviews hosted `664194e7` by capability. It is not a whole-tree upgrade to hosted 1.4.038. The Claude release label and payload manifest remain unchanged.

## Included

- Existing multi-ReClaude management, per-organization quota windows, quota UI and scheduling controls from `c6690f41`; remote transient health checks from `1595571c`.
- The existing Anthropic SSE terminal error fix from main, including failures after stream headers have started. A transport failure must never look like a clean successful EOF.
- Hosted `dd258dec`: read the current reservation count after synchronous admission callbacks, so a callback that releases an older reservation cannot resurrect it.
- Hosted `7b746efc`: remove the staging file after a failed atomic guest-binary replacement, while leaving the old binary and the failure visible.
- Hosted `eb99880f`: remove only incompatible clear-thinking edits after final model/thinking policy. Preserve other edits and supported Claude/ReClaude model behavior.
- An opt-in local GPT gateway adapted from hosted, with explicit endpoint/key binding, protocol conversion and independent terminal/usage checks. See [local-gpt-gateway.md](local-gpt-gateway.md).

## Preserved boundaries

Claude guest kernel, cli-node and cc-node assets retain the existing payload hashes. This change does not run an installer, rebuild guest images, upgrade a CLI, migrate an account, alter a fixed egress pin or clear an exit latch. Existing Pro slots keep their scoped Fable rejection and per-account concurrency; ReClaude retains its separate supported-model policy and authorization/session/quota state.

Whole-tree hosted replacement would delete the ReClaude integration and introduce a global Fable denial, different Claude payloads, account placement, identity/telemetry behavior and deployment assumptions. Those changes are not included. Native GPT image kernels and image endpoints are also not enabled by this gateway-only integration.

## Production rollout

The production deployment includes reviewed local overlays; a source commit alone is not a complete release manifest. Compare the current source, configuration and payload hashes before deployment. Retain the installed guest OS image pin and protocol-mode settings. Publish only reviewed source changes and matching web assets; do not replace the whole running tree or execute hosted's installer.

For a main-gateway reload, drain first, capture current slot eligibility and preserve pre-disabled accounts. Verify actual workers after the reload: a registered or stopped slot is not healthy. Exit-guard restart latches require the operator's explicit maintenance authorization and fresh independent proofs of the already-pinned address. A failed probe or changed address remains blocked. Do not reuse an earlier maintenance authorization, unlock older faults, restore retired accounts, or retry an already-dispatched model request.

Validate API access, scoped routing, terminal errors, known/unknown usage, source hashes and natural traffic. An unconfigured optional GPT backend has no real-provider acceptance result; loopback fixture tests prove adapter behavior, not provider availability. Keep this distinction in the release report.

## Deployment checks learned from this release

- Inventory every web-serving root. An independent management console may be served by the reverse proxy from a host directory, even when the gateway container already has the new build. Copy immutable assets first, retain older hashed assets for open tabs, then atomically replace the public index. Verify the public index and its linked assets against the build; a container-only hash check is insufficient. Static publication does not require a gateway or reverse-proxy restart.
- Distinguish idle HTTP connections and management event streams from unfinished model requests. Require native in-flight/queue checks together with actual unfinished-request metadata before shutdown; an empty usage table cannot establish that nothing is in flight. Temporary diagnostic listeners must close on both success and exception paths.
- Restore each slot through the native sequence: confirm this maintenance's new restart latch and two fresh proofs of its original IP, explicitly rearm, start the worker, diagnose, then resume its matching upstream account. Keep a per-operation intent and read back a timed-out action before proceeding. Do not repeat an uncertain start or request.
- Record the active code separately from the container's original image ID when using a reviewed source overlay. Pin the matching future-compose image without changing other expanded compose settings. Preserve a source/static rollback; never restore an older database over credentials or usage written during maintenance.

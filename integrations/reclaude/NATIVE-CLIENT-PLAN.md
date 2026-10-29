# Native-client evaluation boundary

The existing adapter forwards external Messages requests to a device daemon.
It does not run Claude Code on that device. A daemon with reporting enabled is
therefore not evidence that those requests have native client telemetry.

The local working reference launches the official Claude Code executable on the
bound machine, with that client's own native credential store and configuration.
It removes inherited gateway routing and reporting opt-outs, uses the daemon's
current loopback proxy and CA, and retains a stable client profile across distinct
sessions. Its monitor checks the actual running process, because changing a
settings file cannot reinitialize reporting in an existing process.

These properties can be reused. The Mac launcher, OAuth, device identity, profile,
machine description and older vendor binary must not be copied to a server.

The 2026-10-29 Linux evaluation verified an official Claude Code 2.1.304 manifest
signature and executable hash, installed it only in the new runtime, and ran two
native controls with genuine first-party configuration. Both succeeded. A separate
external gateway control and four Sub2API model controls also succeeded, followed
by another provider revocation. This rejects the hypothesis that installing a CLI
and enabling daemon reporting alone repairs the existing relay. It does not prove
the provider's private trigger or establish whether a native-only workload would
remain authorized long term. No repeated rebind or synthetic telemetry was used.

## Evaluate in a separate native runtime

1. Preserve the existing account, device identity, fixed-egress policy and
   authentication latch. Keep the new relay unscheduled. Never replace an old
   OAuth slot or alter the global slot telemetry settings for this evaluation.
2. Use the official ReClaude launcher for the selected organization and a
   verified official Claude Code build on the bound machine. The native launch
   must not set a custom `ANTHROPIC_BASE_URL` or use a relay key as OAuth.
3. Inspect both launch-time environment and the native binding's settings.
   Remove inherited reporting opt-outs only within this new runtime. Let the
   native launcher manage its current proxy, CA and account configuration;
   preserve true machine information. Do not fabricate events or request IDs.
4. Treat native authorization as a separate gate. A revoked binding is not
   repaired by editing configuration, clearing a local latch or restarting a
   process. Reauthorization, when explicitly permitted, must use the official
   flow for the same intended device and organization, once per recovery.
5. Before model use, verify fixed egress from the actual process namespace,
   native reporting defaults, a valid binding, client integrity and resource
   headroom. Native application health and model readiness are distinct.
6. Use a stable isolated profile with new sessions, not a new identity for each
   probe. With valid authorization, run a bounded fresh native request and then
   inspect actual terminal output, usage, errors and device state. Do not replay
   previously paid requests or use periodic paid health probes.

## A native CLI is not a transparent Messages backend

The CLI owns its system context, session state, tool loop and working directory.
Connecting it to the shared API pool requires explicit tests for client-supplied
tools and tool results, thinking, message history, cancellation, JSON and SSE,
usage accounting, user isolation and resource limits. Tools must not silently
move from the caller's machine to the server. Text-only success cannot pass this
gate or justify shared-pool admission.

The current vm2api OAuth-slot path is not a drop-in native ReClaude launcher:
it uses its own CLI/kernel contract, seed settings and telemetry policy. Even
its telemetry-on seed writes a nonessential-traffic override. Reusing that path
unchanged would reintroduce a configuration difference that the local reference
removed. Keep the seven existing slots unchanged and evaluate independently.

Ten relay permits are not a memory reservation for ten native CLI processes.
Measure native peak memory and queue behavior before enabling that workload.
The current relay remains paused until authorization and the chosen complete
request path are validated. This plan adds no launcher, login, telemetry sender
or background recovery process.

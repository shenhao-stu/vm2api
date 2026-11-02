# Reuse fresh admission health for kernel dispatch

A scheduler admission probe and the following kernel hop previously issued two health GETs. The scheduler now calls the shared probe wrapper; a successful, reachable response naming the same VM can satisfy the next hop for at most `min(configured TTL, 2000 ms)`. Age starts before the probe, so probe latency counts toward expiry. Scheduler cache hits do not refresh this observation. Failed, busy, missing/wrong-identity probes clear it; TTL zero and clock rollback cannot reuse it. Account reservation, fixed-egress guards, watchdogs and session scope are unchanged.

## Source preservation and deployment

This commit is based on `40ed680800dae668d050c79883040e690ffaa540`, whose two target files exactly matched the captured production baseline. Only the tested health-reuse patch, its 13 regression tests and this note are added. The production service has other independently deployed changes: **do not deploy this whole checkout or replace production with the old base image**. Reconcile the complete production manifest before a future image rebuild. The current change was applied as two files to the existing gateway and loaded by a drained restart on 2026-11-02 at 05:54:50 UTC; all other 309 source files were verified unchanged.

Patch SHA-256: `17a95103df2549b8762774de0b8ebd178815901777aa25edd3ad084aeeee8a74`.

| File | Baseline SHA-256 | Deployed SHA-256 |
|---|---|---|
| `src/lib/transport/kernel-router.mjs` | `3bc5eac4943d4c38c6d39ad4b99919b140d8bc8e7481ffe46904de75f4f722c3` | `7c0bf84eea13cc6467c36abf99780b61c2232c1fb6fbd2da5aa204cafdb1eba2` |
| `src/lib/admin/routing-runtime.mjs` | `a6c03dceb50ec2b001b6803602a2f05a29d354285605868050ea70e10703038d` | `9e7fa20a30186e26e4b4a47ded585b2fcb5b64704f9d7484f8c00dfd144097d8` |

Test SHA-256: `b1f76f5d1c180c420d72fbf3aa3e4ef7511cc9c1f39f8c82137d91a51a06b48f` (`test/unit/kernel-health-reuse.test.mjs`).

## Validation and rollout invariants

The production-baseline candidate passed 231 tests on macOS Node 24.22.1 and isolated Linux Node 22.23.4. This branch additionally passed the 13 health-reuse tests and 16 routing-runtime load tests. Tests use local Unix sockets and do not call a model.

For any future reload, first drain requests, preserve current lifecycle/account policy, and reload only a verified artifact. A stopped slot after reload is not ready merely because the gateway health endpoint succeeds. Verify each slot's runtime, credentials, bound proxy and expected exit with independent checks before explicitly restoring it under the applicable maintenance authorization. Do not clear an exit latch automatically or accept a changed IP. Keep per-account concurrency and model restrictions unchanged. Rollback restores only these two baseline files under the same drain and restore checks.

Compare queue wait, request-attempt TTFT and external first-token time separately. Removing one duplicate health round trip does not prove that upstream generation or CLI cold start became faster; report measured samples without a general latency guarantee.

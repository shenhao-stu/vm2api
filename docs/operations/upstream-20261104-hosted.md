# Hosted upstream review — 2026-11-04

Merge dofastted/main `6a8f9c7f` from the prior shared base `177051ba` into the hosted branch. Unmerged upstream feature/release branches are not release inputs.

| Upstream change | Decision |
| --- | --- |
| Sonnet 5.5 `between_tools` thinking | Accept the explicit capability and pre-admission validation; preserve signed tool-loop history. Unsupported models, fields and efforts still fail locally. |
| Kernel thinking display | Accept the missing configuration projection. Preserve existing routing and payload binaries. |
| DSH tool-result pruning continuity | Accept as an opt-in bounded in-memory cache. Leave disabled on the hosted instance. Scope originals by authenticated key, session and model; restore only an exact verified prefix within budgets. |
| Formatting, response fixture and release notes | Accept; the proxy fixture formatting already exists locally. |

Two merge conflicts require hosted-specific integration. Cache transactions settle together with the existing delayed request accounting, after the handler has recorded final outcome and usage. A premature disconnect rolls back; a completed response followed by close does not discard a still-settling verified baseline. Regression coverage includes success and rejection when finish precedes handler return. GPT API passthrough continues to bypass Claude intercept/rewrite logic.

Retain the mounted Claude console, GPT visual style, separate pool Keys, live VM-pool membership, shared-line slot isolation, fixed-IP guard, JEV fail-closed review and native Claude Code transport. The existing Haiku clear-thinking repair remains. Fable stays denied before dispatch and hidden from hosted catalogs. ReClaude native relay remains excluded.

The deployment preserves runtime configuration, accounts, names, pool membership and credentials. Only the hosted gateway is replaced after admission closes and active requests drain; the original GPT service stays running. Existing fixed IPs must be verified before restoring prior scheduling. Payload hashes do not change in this update.

# Native configuration channels

Enable `--configuration-channels` only on a tested native Relay with durable session storage. It is off by default. A single authenticated logical session can use separately initialized model/system configurations without mutating an active CLI model. All branches share the existing account, capacity and logical-session serialization.

Before publishing a paid dispatch grant, persist the caller history digest and grant ID. Complete this record only after a consumed grant and a verified final checkpoint with actual usage. Unknown grants, incomplete histories, failed sessions and unresolved tool results block branching. Changing model, system or sampling controls cannot replay a consumed caller turn. The original history and exact tool-result graph remain authoritative.

Existing session directories without this index keep their old recovery path. This patch does not clear failed sessions or infer that an old ambiguous request was never billed. Per-CLI session budgets cannot be combined with configuration channels; account-level limits remain authoritative.

Deployment: stop new admissions to one Relay, wait for active requests and pending tools to drain, preserve state and source backups, then restart only that Relay HTTP worker. Keep native authentication, daemon, container, fixed exit and all checkpoints/grants. On rollback, the legacy pool must reject any logical session with `.configuration-channels/<logical>.json`; blindly removing the feature would bypass durable branch consumption evidence.

Validation: 263 local tests, 161 native tests on each target Linux environment; five isolated real calls covered auxiliary/main model changes, full-history model return, tool invocation and exact tool-result continuation. Each had one consumed grant and a final observed usage record. No customer replay.

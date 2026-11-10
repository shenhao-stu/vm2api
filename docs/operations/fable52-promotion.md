# Hosted Fable 5.2 launch window

Only `claude-fable-5-2` (and its dotted/configured aliases) is temporarily allowed. Other Fable versions remain denied. The official included-usage window ends on November 16, 2026 at 11:59 pm Pacific: the exclusive server cutoff is **2026-11-17 08:00 UTC / 16:00 Asia/Shanghai**. Start is conservatively pinned to the November 9 10:00 am Pacific launch. No rolling seven-day timer, cron job, restart or operator action is needed to close admission.

The ingress, live catalog, account eligibility and final dispatch check enforce the window. Requests admitted to the upstream before the deadline may finish; queued requests cannot start afterward. Persisted model switches, per-slot allowlists, native Fable quota windows, concurrency, cancellation, session affinity, refusal isolation, bans and revoked-account holds still apply. API-channel Fable fallbacks remain disabled. Usage-credit opt-in stays disabled. Native reset cards have a separate opt-in automation described in `claude-pro-tier-and-reset.md`. Native Fable quota utilization is normalized to 0–1; 1 blocks allocation even before its status changes to rejected. This is not a forecast of tokens in the next request.

Fable usage is no longer allowed to relabel an explicitly identified Pro account as Max. This preserves the Pro refusal-isolation scope during the promotion. A successful Fable request only clears its model entitlement error.

The 5.2 matrix uses adaptive thinking, 1M context, 128K output cap and default high effort. Forced tools remain a local validation error. Manual/disabled thinking is normalized as with Opus 5.5. The gateway retains returned thinking blocks and does not opt into dropping mismatched prefixes. The upstream's new all-account thinking-prefix validation makes stable account, tools and conversation history important.

## Review of upstreams on 2026-11-10

- `origin/dev/hosted` `8f339301`: retained Codex text preflight, quality/rest controls and official-credit UI.
- `dofastted/main` `0d78e150`: adopted `0a62a5b8` / PR917 cache marker budget fix, preserving final CLI system anchors without losing message/tool content.
- `Fwind43/main` `6b94d337`: adopted the removal of the false Pro→Max success promotion; replaced its unconditional Fable gate removal with exact model and deadline checks. Its opening of unknown plans and every Fable model was rejected.
- Latest upstream PR947 (Claude Code2.1.321), PR946 (AppArmor), PR943 (CRAG request normalization), PR942/945 and merged CRAG2 series require a kernel/container migration. They are not prerequisites for model ID forwarding and were not blindly merged into the stable hosted deployment.
- Unrelated redaction rewrites, tenant UI and request-body/routing optimizations are deferred from this release. They need their own behavior/performance review, rather than replacing the hosted queue and isolation implementations.

Official client users need Claude Code2.1.321+ for its native model picker. The hosted gateway's kernel and bundled CLI are a separate compatibility question; retain their checksums unless a real canary demonstrates a necessary upgrade. Never merely raise the advertised version.

Sources (verified in browser on 2026-11-10):
- https://support.claude.com/en/articles/17506494-claude-fable-5-2-launch-offers
- https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan
- https://platform.claude.com/docs/en/models/fable-5-2/overview
- https://platform.claude.com/docs/en/models/fable-5-2/migration-guide

Operational receipts and deployment decision are recorded separately in the managed project journal; no credentials belong in this document.

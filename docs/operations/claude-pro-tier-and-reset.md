# Claude Pro subscription and reset cards

Fable entitlement is not subscription evidence. Official `/usage`, Fable success and quota headers update usage only. `/api/oauth/profile` determines Pro/Max; a profile-sourced subscription cannot be replaced by usage observations. The frontend follows the subscription while showing a separate Fable quota row when the entitlement exists. Existing incorrectly persisted `max`/`usage` records require a profile-verified repair in both VM metadata and the account store; never blindly downgrade a genuine Max account.

`routing.claude_reset.enabled=true` opts the hosted Claude Pro pool into this launch's automatic native reset. Default is off. Only running, authorized Pro OAuth slots participate; manual holds, banned/revoked accounts, native relay slots and GPT are excluded. The service checks native cards at most every six hours when idle, or at most every five minutes when a cached Fable limit or expiry is due. It makes no model calls.

A reset is considered only when the native card's `seven_day_overage_included` percent reaches100, or within15minutes of that card's own expiry. Overall weekly exhaustion and five-hour exhaustion alone do not trigger it. The grant must still be eligible, usable, current and within the Fable5.2 launch window. Conditions are rechecked from fresh native grant state immediately before claiming.

The monitor holds the account's inference permit during query/claim/reconciliation. Native account/org leases and persistent idempotency/unknown-outcome fences prevent duplicate consumption, including after restart. Unknown outcomes are never automatically resubmitted. Successful resets refresh official usage; no policy/manual holds are forcibly cleared. The launch operation permits at most one automatic reset per account and does not enable usage-credit billing.

Official resets restore only Fable's weekly consumption, plus the whole five-hour window. They do not restore other models' weekly consumption. Cards may expire earlier than the model-admission cutoff: always use the returned expiry. All automatic checks stop at2026-11-17T08:00Z.

Source: https://support.claude.com/en/articles/17506494-claude-fable-5-2-launch-offers

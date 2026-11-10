# Fable 5.2 launch support

This release adds `claude-fable-5-2` without replacing the existing Claude CLI,
kernel, slot worker, telemetry configuration, ReClaude or Codex adapters.

The Pro entitlement is temporary: from 2026-11-09 18:00 UTC until the exclusive
2026-11-17 07:59 UTC boundary returned by native launch grants. Max/Ultra keep
normal Fable eligibility. Pro gets only 5.2 through this deployment; existing
restrictions on older Fable models stay in place. The slot allowlist remains an
additional requirement, including pinned diagnostic traffic and queued requests.

Plan identity comes from the account's explicit OAuth profile, independently of
which models appear in usage. Temporary Fable access must never relabel Pro as
Max. The Fable allowance is its separate `seven_day_overage_included` window;
50% of the aggregate weekly meter is not an exhaustion test.

Use the existing native reset-credit endpoints. The optional maintenance job
and independent Sub2API account-list expiry are documented in
[integrations/claude-fable-maintenance](../../integrations/claude-fable-maintenance/README.md).
They preserve account/organization identity, durable idempotency and unknown
operation fences. They never enable paid overage or clear fixed-exit latches.

Standard official rates per million tokens are input $8, output $40, cache write
5m $10 / 1h $16, cache read $0.20. Explicit fast mode costs twice the standard
rate. Fable 5.2 uses adaptive thinking, defaults to high effort, supports 1M
context and up to 128K output; unsupported sampling fields are removed. Existing
model-specific behavior and administrator model overrides remain intact.

Selected upstream changes: model metadata, explicit subscription metadata, and
valid weekly-only usage responses. A wholesale upstream binary/CLI replacement
and a fork's permanent removal of the Pro Fable gate were deliberately excluded.

Sources:
- https://support.claude.com/en/articles/17506494-claude-fable-5-2-launch-offers
- https://platform.claude.com/docs/en/models/fable-5-2/overview
- https://platform.claude.com/docs/en/about-claude/pricing
- https://platform.claude.com/docs/en/models/fable-5-2/migration-guide

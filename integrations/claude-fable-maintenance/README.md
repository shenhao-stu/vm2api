# Fable launch maintenance

Native model dispatch enforces the Pro launch window independently of these jobs:
`2026-11-09T18:00:00Z <= now < 2026-11-17T07:59:00Z`.
Max/Ultra are not subject to the Pro deadline. Subscription identity comes from
OAuth profile metadata; model access or usage never upgrades a Pro account.

## Native reset cards

Run `main.mjs` every five minutes through a systemd oneshot (Linux `flock` required).
The only network destination is the loopback panel API; native slot workers use
their existing account and fixed egress for official metadata and redemption.

Required environment:

- `VM2API_FABLE_RESET_STATE`: absolute path to durable operator-owned state.
- `VM2API_FABLE_AUTO_RESET=1`: enable automatic redemption; otherwise no queries or claims.
- `VM2API_PANEL_KEY_FILE`: absolute restricted file containing the existing panel key;
  inside the existing gateway container, its `VM2API_API_KEY` may be used instead.
- `VM2API_PANEL_URL`: defaults to `http://127.0.0.1:18787/api/panel`.

Only scheduled, running native Pro/Max accounts with a fresh, ready, unchanged
fixed-exit guard are eligible. Redeem one official card when its Fable allowance
is exhausted, or it expires within 24 hours and a covered allowance has been used.
Do not enable paid overage. Zero-use cards are not spent merely to test this job.

Ordinary 5H or 7D exhaustion is not Fable exhaustion. For example, 5H at 100%
and Fable at 13% must leave a non-expiring card untouched, even if the official
endpoint permits early redemption or the card also clears 5H. A request to
restore scheduling does not authorize an early manual redemption. Outside the
automatic policy, require an explicit instruction to spend that card; otherwise
retain the real upstream cooldown. Never omit `auto_reset` to bypass a skipped
automatic decision.

The state is account-scoped. Intent is durable before redemption, and the native
endpoint rechecks official eligibility, account/organization and idempotency.
Unknown outcomes remain blocked for manual reconciliation; restarting the job
never authorizes a replay. Preserve the state and native reset ledger on upgrades.

## Sub2API expiry

`python3 expire_sub.py --config /absolute/restricted/config.json` removes only
explicitly marked Pro Fable5.2 mappings after the deadline. Use a five-minute
systemd timer, loopback admin URL, restricted token file and a shared release lock.
The VM dispatch deadline remains authoritative if this independent cleanup fails.

Each configuration account contains `account_id`, `base_url`, `expires_at` and a
unique deployment `marker`. Its Sub2API `extra.vm2api_fable_pro_promotion` must
match that marker, with `tier: pro` and `model: claude-fable-5-2`. Other credential
fields, group membership, scheduling, concurrency and user affinity are preserved.
An empty or broad model mapping is rejected instead of granting all models.

Monitor systemd failures, blocked reset intents and expiry readback. Never clear
an exit latch or restore a manually stopped account from either maintenance job.

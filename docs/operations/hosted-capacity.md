# Hosted Claude capacity policy

The managed deployment applies `deploy/hosted-routing.patch.json` through the
native routing API. It is a partial patch, not a replacement routing file.
Existing credentials, quota thresholds, model restrictions and GPT settings
remain in their own configuration.

The current limits are one concurrent request and ten active session seats per
Claude account, no per-minute request cap, and the original fifty waiting requests
across the pool. All Claude tiers inherit these defaults; explicit VM overrides
must be checked when onboarding. The existing Claude pool Key remains at total
concurrency one. A busy Key returns an admission 429 before selecting an account;
clients should serialize requests or use bounded backoff, not fan out retries.

A session seat covers in-flight work and queued continuation requests. It is not
a count of all historical conversations or an instruction to delete conversation
history. The existing 24-hour sticky preference keeps continuations on their
healthy home account; native idle session caches retain their 10-minute expiry.
An active session waits on its home concurrency instead of splitting across VMs.
Unavailable accounts can fail over before output: at most two attempts and one
account switch per request, with no same-account retry. Existing circuit policy
remains three qualifying failures, a five-minute open period and one half-open
probe. Fable stays excluded and DSH stays disabled.

New sessions use the existing balanced policy: same-priority accounts are ranked
by active seat occupancy and remaining quota. The managed slots now have equal
priority and weight; previous manually paused slots remain paused. This balances
capacity, not an exact round-robin count of requests. Do not move healthy existing
sessions merely to equalize counts.

When adding the proposed 30 accounts, import each as an independent identity and
verify its fixed egress, token health, concurrency, seat cap, RPM and pool binding.
Spread new sessions across healthy capacity; do not raise the shared Key limit
merely because accounts were added. These controls provide bounded workload and
session continuity; they do not establish provider approval or guarantee against
account restrictions.

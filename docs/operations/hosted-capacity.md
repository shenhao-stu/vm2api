# Hosted Claude capacity policy

The managed deployment applies `deploy/hosted-routing.patch.json` through the
native routing API. It is a partial patch, not a replacement routing file.
Existing credentials, quota thresholds, model restrictions and GPT settings
remain in their own configuration.

The current limits are one concurrent request and ten active session seats per
Claude account, no per-minute request cap, and the original fifty waiting requests
across the pool. All Claude tiers inherit these defaults; explicit VM overrides
must be checked when onboarding. The shared Claude Key has `max_concurrency=0`:
it adds no separate key cap. With N healthy schedulable accounts, at most N
provider requests execute concurrently; the pool keeps at most 50 waiting
requests, then returns `pool_wait_queue_full`. A timeout returns
`pool_queue_timeout`. Clients should use bounded backoff on these capacity
errors rather than fan out retries. Existing explicit per-key limits and tenant
limits still apply when an operator chooses them.

`concurrency.default_key_concurrency=0` is independent of the account tier
concurrency. Saving account defaults must not reset it to one. New Claude keys
and switching to the Claude service use this pooled default; editing an existing
key preserves its explicit cap. GPT key defaults and its gateway remain separate.

A session seat covers in-flight work and queued continuation requests. It is not
a count of all historical conversations or an instruction to delete conversation
history. The existing 24-hour sticky preference keeps continuations on their
healthy home account; native idle session caches retain their 10-minute expiry.
Continuations also wait on the healthy home after a completed turn releases its
seat. A busy home keeps this binding until the request deadline; the new-session
sticky grace cannot spill that continuation onto another account. Draining,
unavailable or failed accounts retain the existing migration rules.
Unavailable accounts can fail over before output: at most two attempts and one
account switch per request, with no same-account retry. Existing circuit policy
remains three qualifying failures, a five-minute open period and one half-open
probe. Fable stays excluded and DSH stays disabled.

New sessions use the existing balanced policy: same-priority accounts are ranked
by active seat occupancy and remaining quota. The managed slots now have equal
priority and weight. Preserve the live schedulable state when publishing;
do not restore an older paused-slot snapshot. This balances
capacity, not an exact round-robin count of requests. Do not move healthy existing
sessions merely to equalize counts.

When adding the proposed 30 accounts, import each as an independent identity and
verify its fixed egress, token health, concurrency, seat cap, RPM and pool binding.
Add healthy accounts to the existing authorized VM pool; the same shared Key
then uses their capacity without key rotation or a new fixed key limit. New
sessions spread across healthy capacity while existing sessions keep affinity.
The 35-account regression verifies one active request per account, a 50-request
queue, overflow rejection, wake-up on release and cancellation cleanup without
provider calls. This is a scheduler test; actual server resource capacity must
also be checked when onboarding the proposed fleet. These controls provide bounded workload and
session continuity; they do not establish provider approval or guarantee against
account restrictions.

# Model restrictions for Sub2API accounts

Give each Sub2API account an explicit, nonempty `credentials.model_mapping`
containing models that its backing slot can actually serve. An identity mapping
such as `model-name: model-name` acts as a whitelist. A provider-wide catalog
does not establish the entitlement of an individual subscription.

For Claude Pro slots, exclude `claude-fable-*` from both mapping keys and targets.
Do not leave a broad `claude-*` wildcard or clear the entire mapping: in Sub2API,
an empty mapping allows every model. Keep permitted Haiku, Sonnet and Opus
entries unchanged. Separate Max or other authorized backends need their own
verified model restrictions; do not remove their Fable entries as a side effect.

Use the native account editor/API. On the audited Sub2API version, an account
credentials update replaces nonsensitive fields while preserving omitted secret
fields. Read the current account, change only `model_mapping` in its complete
public credentials object, and preserve the base URL and cooldown rules. Check
the saved account and scheduler cache. Preserve keys, groups, affinity, proxy,
status and concurrency. No service restart is needed for this configuration.

vm2api also has a native subscription-tier gate. A Pro Fable request is rejected
with `fable_requires_max` before model dispatch, even if a slot allowlist contains
Fable. Keep that gate. Rejecting earlier in Sub2API avoids unnecessary forwarding,
candidate retries and misleading rate-limit records.

When reviewing failures, distinguish final errors from Sub2API's recovered
candidate errors. HTTP 200 alone is insufficient for streaming success: inspect
the terminal state, error code and complete stream. A committed stream that
stalls must not be replayed automatically or recorded as a successful completion.
Do not disable quota, request-validation or concurrency guards to remove errors
from a dashboard.

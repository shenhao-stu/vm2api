# Native Claude subscription session protection

The existing `pro_session_quarantine_enabled` switch applies to native Claude Pro **and Max** subscription slots. Its name and storage remain unchanged for compatibility. API-key-backed Relay accounts, Codex slots, and unknown tiers keep their existing policies.

A confirmed upstream refusal preserves the original response and usage, then isolates that authenticated conversation and refused context before another dispatch, including count_tokens. Clean conversations and other authenticated clients remain independent. Disabling the existing switch restores the prior refusal policy. It does not release paid/unknown requests or remove stored quarantine evidence.

Coverage: JSON/SSE refusals, Continue, count_tokens under OAuth/API key categories, disabled behavior, and mixed-pool API slots. No CLI, kernel or database-schema change is required.

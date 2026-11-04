-- Counts and bounded outcome categories only; never store original tool text.
ALTER TABLE usage_logs ADD COLUMN tool_prune_reason TEXT;
ALTER TABLE usage_logs ADD COLUMN tool_prune_restored INTEGER;
ALTER TABLE usage_logs ADD COLUMN tool_prune_restored_bytes INTEGER;

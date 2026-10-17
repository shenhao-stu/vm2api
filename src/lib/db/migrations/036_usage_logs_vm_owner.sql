-- 036_usage_logs_vm_owner — owner of the serving VM at write time.
-- Tenant log scope matches this instead of the VM's current owner, so
-- assigning a slot to a tenant does not expose rows served before that.
-- Existing rows stay NULL on purpose: back-filling from vms.owner_user_id
-- would re-create the leak for history.

ALTER TABLE usage_logs ADD COLUMN vm_owner_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_logs_vm_owner ON usage_logs(vm_owner_user_id, created_at);

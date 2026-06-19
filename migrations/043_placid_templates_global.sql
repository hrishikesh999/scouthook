-- Make placid_templates global (admin-managed, not per-workspace)
ALTER TABLE placid_templates DROP COLUMN IF EXISTS tenant_id;
DROP INDEX IF EXISTS placid_templates_tenant_order;
CREATE INDEX IF NOT EXISTS placid_templates_order ON placid_templates (sort_order);

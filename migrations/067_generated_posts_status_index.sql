-- Composite index for drafts/published listing queries.
-- Covers: WHERE tenant_id = ? AND status = ? ORDER BY created_at/published_at DESC
CREATE INDEX IF NOT EXISTS idx_generated_posts_tenant_status
  ON generated_posts (tenant_id, status, created_at DESC);

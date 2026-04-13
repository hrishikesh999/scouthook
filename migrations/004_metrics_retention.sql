-- Metrics retention policy.
-- Engagement data (likes, comments, reactions) sourced from LinkedIn is cleared
-- after 90 days per LinkedIn API Terms of Use data minimisation requirements.
-- The post itself (content, status, published_at) is retained indefinitely.
-- last_synced_at is set to NULL to indicate the metrics are stale rather than
-- dropping the columns, so the UI can show "metrics unavailable" rather than zeros.

-- No schema change required — the cleanup runs as a periodic server-side job
-- (see server.js metricsRetentionCleanup). This migration is a record of the policy.

-- Optional: index to make the cleanup query efficient if the table grows large.
CREATE INDEX IF NOT EXISTS idx_generated_posts_last_synced
  ON generated_posts (last_synced_at)
  WHERE last_synced_at IS NOT NULL;

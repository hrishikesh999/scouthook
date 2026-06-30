-- Add per-user index to platform_events for efficient per-user activity log queries.
-- The existing index is (event_type, created_at) — good for dashboard aggregates
-- but forces a full user-scan for the /admin/users/:userId/activity endpoint.
CREATE INDEX IF NOT EXISTS idx_platform_events_user_date ON platform_events(user_id, created_at DESC);

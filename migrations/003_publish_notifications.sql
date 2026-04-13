-- User-facing notifications for async events (e.g. scheduled post failures).
-- Polled by the dashboard via GET /api/notifications.

CREATE TABLE IF NOT EXISTS notifications (
  id          bigserial   PRIMARY KEY,
  user_id     text        NOT NULL,
  tenant_id   text        NOT NULL DEFAULT 'default',
  type        text        NOT NULL,             -- 'publish_failed' | 'publish_succeeded'
  title       text        NOT NULL,
  body        text,
  ref_id      bigint,                           -- e.g. scheduled_post_id
  ref_type    text,                             -- e.g. 'scheduled_post'
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_unread
  ON notifications (user_id, tenant_id, read_at)
  WHERE read_at IS NULL;

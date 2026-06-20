CREATE TABLE IF NOT EXISTS platform_events (
  id           bigserial   PRIMARY KEY,
  event_type   text        NOT NULL,
  user_id      text        NOT NULL,
  workspace_id text,
  metadata     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_platform_events_type_date ON platform_events(event_type, created_at);

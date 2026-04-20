-- Add email and display_name to user_profiles so emails can be sent without
-- consulting an external identity provider. Both are populated from the Google
-- OAuth profile on every login (upsert in server.js).
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS email        text,
  ADD COLUMN IF NOT EXISTS display_name text;

-- Track emails sent per user to allow deduplication (e.g. reconnect, payment-failed).
-- template: template name (e.g. 'linkedin-reconnect')
-- dedup_key: optional freeform key to deduplicate within a billing/connection cycle
CREATE TABLE IF NOT EXISTS email_log (
  id          bigserial PRIMARY KEY,
  user_id     text        NOT NULL,
  template    text        NOT NULL,
  dedup_key   text,
  sent_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_log_user_template ON email_log (user_id, template, sent_at);

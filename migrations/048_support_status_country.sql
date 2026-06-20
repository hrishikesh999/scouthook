ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS status     VARCHAR(20) NOT NULL DEFAULT 'open';
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS admin_note TEXT;
ALTER TABLE user_profiles    ADD COLUMN IF NOT EXISTS country    VARCHAR(2);

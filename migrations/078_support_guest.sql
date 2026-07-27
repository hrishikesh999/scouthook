-- Allow support tickets from logged-out visitors: user_id becomes optional,
-- guest submissions carry their own email/name instead.
ALTER TABLE support_requests ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS guest_email TEXT;
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS guest_name  TEXT;

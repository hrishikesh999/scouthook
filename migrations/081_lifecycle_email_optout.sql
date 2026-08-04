-- 081_lifecycle_email_optout.sql
-- One-click unsubscribe for lifecycle email (welcome sequence + trial nudges).
-- Transactional mail (receipts, password reset, publish failures) ignores this
-- flag by design — those are not marketing and must always deliver.
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS lifecycle_emails_opt_out_at timestamptz;

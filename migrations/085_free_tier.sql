-- Replace the 7-day trial with a lifetime 3-free-post cap for non-paying users.
-- free_tier_started_at: a single ALTER TABLE snapshot timestamp for all existing
-- rows (their historical trial-era generations don't count against the new cap);
-- new rows default to their insert time (signup), so their whole history counts.
-- free_posts_limit: per-user override so admins can grant bonus free posts.
ALTER TABLE user_subscriptions
  ADD COLUMN IF NOT EXISTS free_tier_started_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS free_posts_limit integer NOT NULL DEFAULT 3;

-- Normalize existing app-level trial rows (status='trialing', never had a
-- Paddle subscription) to the new free-tier status. Without this, the raw
-- `status` column would keep reading 'trialing' forever and stale
-- trial_ends_at-based UI (billing.html, account-bar.js) would still render.
-- Paddle-managed trials (paddle_subscription_id set) are left untouched.
-- plan stays 'expired' (chk_plan_values only allows 'expired'|'solo'|'pro' as
-- of migration 066); 'free' is only ever a status value, not a plan value.
UPDATE user_subscriptions
SET plan = 'expired', status = 'free'
WHERE status = 'trialing' AND paddle_subscription_id IS NULL;

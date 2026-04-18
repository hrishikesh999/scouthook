-- 010_founding_pricing.sql
-- Founding member pricing tiers + visual generation limit tracking

-- Track which Paddle price tier each subscriber locked in at.
-- Used for auditing; tier advancement is determined server-side by counting pro rows.
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS price_id text;

-- Log each visual generation event (carousel / quote_card / branded_quote).
-- Used to enforce per-month limits for Pro (20/month) and first-month limits for Free (3 in month 1 only).
CREATE TABLE IF NOT EXISTS visual_generation_log (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL,
  tenant_id   text NOT NULL DEFAULT 'default',
  post_id     bigint,
  visual_type text NOT NULL,  -- 'quote_card' | 'carousel' | 'branded_quote'
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_visual_gen_log_user ON visual_generation_log (user_id, created_at);

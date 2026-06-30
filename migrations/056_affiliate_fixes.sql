-- Robustness fixes for the affiliate module
-- Addresses race conditions, duplicate payouts, and click deduplication

-- Prevent two pending payouts for the same affiliate (eliminates the race condition
-- in requestPayout where check-then-insert could let two concurrent requests through)
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_payouts_one_pending
  ON affiliate_payouts (affiliate_id)
  WHERE status = 'pending';

-- Click deduplication: one unique click counted per IP per referral code per UTC day.
-- Uses floor(epoch/86400) instead of DATE(created_at) because DATE(timestamptz)
-- is STABLE (timezone-dependent), not IMMUTABLE — PostgreSQL forbids STABLE
-- functions in index expressions.
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_clicks_dedup
  ON affiliate_clicks (referral_code, ip_hash, (floor(extract(epoch from created_at) / 86400))::bigint);

-- Track when referral status last changed (useful for auditing churn detection)
ALTER TABLE affiliate_referrals
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

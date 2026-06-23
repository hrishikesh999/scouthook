-- Robustness fixes for the affiliate module
-- Addresses race conditions, duplicate payouts, and click deduplication

-- Prevent two pending payouts for the same affiliate (eliminates the race condition
-- in requestPayout where check-then-insert could let two concurrent requests through)
CREATE UNIQUE INDEX affiliate_payouts_one_pending
  ON affiliate_payouts (affiliate_id)
  WHERE status = 'pending';

-- Click deduplication: one unique click counted per IP per referral code per day
CREATE UNIQUE INDEX affiliate_clicks_dedup
  ON affiliate_clicks (referral_code, ip_hash, DATE(created_at));

-- Track when referral status last changed (useful for auditing churn detection)
ALTER TABLE affiliate_referrals
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

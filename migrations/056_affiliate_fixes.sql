-- Robustness fixes for the affiliate module
-- Addresses race conditions, duplicate payouts, and click deduplication

-- Prevent two pending payouts for the same affiliate (eliminates the race condition
-- in requestPayout where check-then-insert could let two concurrent requests through)
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_payouts_one_pending
  ON affiliate_payouts (affiliate_id)
  WHERE status = 'pending';

-- Click deduplication: one unique click counted per IP per referral code per UTC day.
-- extract(epoch from timestamptz) is itself STABLE, not IMMUTABLE — the generic extract()
-- dispatch also covers timezone-dependent fields (hour, day, etc.), so PostgreSQL won't allow
-- it directly in an index expression even though epoch itself is timezone-invariant. Wrap it in
-- a same-body SQL function marked IMMUTABLE so the index can be built.
CREATE OR REPLACE FUNCTION affiliate_click_epoch_day(ts TIMESTAMPTZ) RETURNS BIGINT AS $$
  SELECT floor(extract(epoch from ts) / 86400)::bigint
$$ LANGUAGE sql IMMUTABLE;

CREATE UNIQUE INDEX IF NOT EXISTS affiliate_clicks_dedup
  ON affiliate_clicks (referral_code, ip_hash, affiliate_click_epoch_day(created_at));

-- Track when referral status last changed (useful for auditing churn detection)
ALTER TABLE affiliate_referrals
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

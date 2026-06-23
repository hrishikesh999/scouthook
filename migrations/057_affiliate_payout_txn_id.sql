ALTER TABLE affiliate_payouts
  ADD COLUMN IF NOT EXISTS paypal_txn_id TEXT;

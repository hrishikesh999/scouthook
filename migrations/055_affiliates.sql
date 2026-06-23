-- Affiliate / Partner Program tables and default platform settings

CREATE TABLE affiliates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               TEXT NOT NULL REFERENCES user_profiles(user_id),
  referral_code         TEXT NOT NULL UNIQUE,
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','inactive','suspended')),
  commission_rate_pct   INTEGER NOT NULL DEFAULT 0,
  wallet_balance_cents  INTEGER NOT NULL DEFAULT 0,
  total_earned_cents    INTEGER NOT NULL DEFAULT 0,
  total_paid_cents      INTEGER NOT NULL DEFAULT 0,
  payout_method_type    TEXT,
  payout_method_details TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

CREATE TABLE affiliate_referrals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id          UUID NOT NULL REFERENCES affiliates(id),
  referred_user_id      TEXT NOT NULL REFERENCES user_profiles(user_id),
  referral_code         TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'signed_up'
                          CHECK (status IN ('signed_up','converted','churned','fraud')),
  signed_up_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  converted_at          TIMESTAMPTZ,
  total_posts_published INTEGER NOT NULL DEFAULT 0,
  milestone_bonus_paid  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(referred_user_id)
);

CREATE TABLE affiliate_commissions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id          UUID NOT NULL REFERENCES affiliates(id),
  referral_id           UUID NOT NULL REFERENCES affiliate_referrals(id),
  type                  TEXT NOT NULL CHECK (type IN ('subscription','renewal','bonus')),
  amount_cents          INTEGER NOT NULL,
  paddle_transaction_id TEXT UNIQUE,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','confirmed','paid','reversed')),
  clears_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE affiliate_payouts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id  UUID NOT NULL REFERENCES affiliates(id),
  amount_cents  INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','paid','failed')),
  note          TEXT,
  paid_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE affiliate_clicks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_code  TEXT NOT NULL,
  ip_hash        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON affiliate_referrals (affiliate_id);
CREATE INDEX ON affiliate_commissions (affiliate_id);
CREATE INDEX ON affiliate_commissions (paddle_transaction_id);
CREATE INDEX ON affiliate_clicks (referral_code, created_at);

INSERT INTO platform_settings (key, value) VALUES
  ('affiliate_commission_rate_pct', '10'),
  ('affiliate_bonus_cents',         '200'),
  ('affiliate_milestone_posts',     '100'),
  ('affiliate_min_payout_cents',    '1000'),
  ('affiliate_program_active',      'true')
ON CONFLICT (key) DO NOTHING;

-- 009_billing.sql
-- Paddle subscription tracking for Free/Pro plans

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id                      bigserial PRIMARY KEY,
  user_id                 text NOT NULL UNIQUE,
  paddle_customer_id      text,
  paddle_subscription_id  text,
  plan                    text NOT NULL DEFAULT 'free',   -- 'free' | 'pro'
  status                  text NOT NULL DEFAULT 'free',   -- 'free' | 'active' | 'trialing' | 'canceled' | 'past_due' | 'paused'
  current_period_end      timestamptz,
  canceled_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id
  ON user_subscriptions (user_id);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_paddle_sub_id
  ON user_subscriptions (paddle_subscription_id)
  WHERE paddle_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_paddle_cust_id
  ON user_subscriptions (paddle_customer_id)
  WHERE paddle_customer_id IS NOT NULL;

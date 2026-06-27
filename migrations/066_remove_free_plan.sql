-- Remove free plan: rename 'free' to 'expired' and update CHECK constraint
-- Any existing rows with plan='free' are updated to 'expired'.

UPDATE user_subscriptions SET plan = 'expired' WHERE plan = 'free';
UPDATE user_subscriptions SET status = 'expired' WHERE status = 'free';

ALTER TABLE user_subscriptions ALTER COLUMN plan SET DEFAULT 'expired';
ALTER TABLE user_subscriptions ALTER COLUMN status SET DEFAULT 'expired';

ALTER TABLE user_subscriptions DROP CONSTRAINT IF EXISTS chk_plan_values;
ALTER TABLE user_subscriptions ADD CONSTRAINT chk_plan_values
  CHECK (plan IN ('expired', 'solo', 'pro'));

-- Adds the 'deluxe' tier to the plan enum.
--
-- Must land BEFORE any Paddle webhook can write it. The constraint rejects
-- unknown plan values (added in 036, narrowed in 066), so a subscription.created
-- for a Deluxe price arriving at a server whose database has not run this would
-- fail on the constraint and leave a paying customer with no subscription row —
-- which reads, everywhere else in the app, as free tier.
--
-- 'solo' is kept in the list. It is not purchasable (routes/billing.js rejects it
-- at /upgrade) and no rows use it, but dropping a value from a CHECK is a
-- separate decision from adding one, and doing both at once means a rollback
-- cannot restore either.
ALTER TABLE user_subscriptions DROP CONSTRAINT IF EXISTS chk_plan_values;
ALTER TABLE user_subscriptions ADD CONSTRAINT chk_plan_values
  CHECK (plan IN ('expired', 'solo', 'pro', 'deluxe'));

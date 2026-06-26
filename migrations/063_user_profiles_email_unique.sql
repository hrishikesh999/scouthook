-- Enforce email uniqueness at the DB level.
-- Duplicate accounts with the same email were possible because user_profiles.email
-- had no UNIQUE constraint and the signup check only matched auth_providers
-- with provider='email', missing Google OAuth users.
-- Delete any orphaned duplicates (keep the oldest row per email) before adding constraint.

-- First remove affiliate-related rows that reference the duplicate user_profiles
-- (affiliate_commissions → affiliate_referrals → affiliates → user_profiles)
DELETE FROM affiliate_commissions
WHERE referral_id IN (
  SELECT ar.id FROM affiliate_referrals ar
  WHERE ar.referred_user_id IN (
    SELECT user_id FROM user_profiles
    WHERE id NOT IN (SELECT MIN(id) FROM user_profiles WHERE email IS NOT NULL GROUP BY email)
    AND email IS NOT NULL
  )
)
OR affiliate_id IN (
  SELECT a.id FROM affiliates a
  WHERE a.user_id IN (
    SELECT user_id FROM user_profiles
    WHERE id NOT IN (SELECT MIN(id) FROM user_profiles WHERE email IS NOT NULL GROUP BY email)
    AND email IS NOT NULL
  )
);

DELETE FROM affiliate_payouts
WHERE affiliate_id IN (
  SELECT a.id FROM affiliates a
  WHERE a.user_id IN (
    SELECT user_id FROM user_profiles
    WHERE id NOT IN (SELECT MIN(id) FROM user_profiles WHERE email IS NOT NULL GROUP BY email)
    AND email IS NOT NULL
  )
);

DELETE FROM affiliate_referrals
WHERE referred_user_id IN (
  SELECT user_id FROM user_profiles
  WHERE id NOT IN (SELECT MIN(id) FROM user_profiles WHERE email IS NOT NULL GROUP BY email)
  AND email IS NOT NULL
)
OR affiliate_id IN (
  SELECT a.id FROM affiliates a
  WHERE a.user_id IN (
    SELECT user_id FROM user_profiles
    WHERE id NOT IN (SELECT MIN(id) FROM user_profiles WHERE email IS NOT NULL GROUP BY email)
    AND email IS NOT NULL
  )
);

DELETE FROM affiliates
WHERE user_id IN (
  SELECT user_id FROM user_profiles
  WHERE id NOT IN (SELECT MIN(id) FROM user_profiles WHERE email IS NOT NULL GROUP BY email)
  AND email IS NOT NULL
);

DELETE FROM user_profiles
WHERE id NOT IN (
  SELECT MIN(id) FROM user_profiles WHERE email IS NOT NULL GROUP BY email
)
AND email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_email_unique
  ON user_profiles (email)
  WHERE email IS NOT NULL;

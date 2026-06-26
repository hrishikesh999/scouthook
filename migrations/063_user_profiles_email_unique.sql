-- Enforce email uniqueness at the DB level.
-- Duplicate accounts with the same email were possible because user_profiles.email
-- had no UNIQUE constraint and the signup check only matched auth_providers
-- with provider='email', missing Google OAuth users.
-- Delete any orphaned duplicates (keep the oldest row per email) before adding constraint.
DELETE FROM user_profiles
WHERE id NOT IN (
  SELECT MIN(id) FROM user_profiles WHERE email IS NOT NULL GROUP BY email
)
AND email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_email_unique
  ON user_profiles (email)
  WHERE email IS NOT NULL;

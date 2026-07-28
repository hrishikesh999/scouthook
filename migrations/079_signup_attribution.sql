-- 079_signup_attribution.sql
--
-- Paid-acquisition attribution + a one-time signup-conversion marker.
--
-- Why: Meta ads carry utm_* tags that previously died at the landing page —
-- nothing was persisted, so a paid signup could never be traced back to the
-- ad that produced it (or, more importantly, followed forward to see whether
-- that ad's users retained). These columns are written once, at user creation,
-- from the sh_attr cookie (see services/attribution.js).
--
-- signup_conversion_fired_at is the exactly-once guard for the Meta pixel's
-- CompleteRegistration event. The client asks the server whether to fire; the
-- server claims the event atomically so reloads, multiple devices, and cleared
-- browser storage can never double-count a registration.

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS utm_source   TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS utm_medium   TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS utm_content  TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS utm_term     TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS click_id     TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS landing_page TEXT;

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS signup_conversion_fired_at TIMESTAMPTZ;

-- Campaign/content are the two we actually slice by (which angle won, and did
-- its users stay), so index them together. Partial — the vast majority of rows
-- are organic and carry no campaign.
CREATE INDEX IF NOT EXISTS idx_user_profiles_utm_campaign
  ON user_profiles (utm_campaign, utm_content)
  WHERE utm_campaign IS NOT NULL;

-- Backfill: every user who existed before this migration has already registered.
-- Without this, an existing user who happens to land on onboarding.html would
-- fire a CompleteRegistration and poison the pixel's conversion data. Only rows
-- inserted after this migration start life with a NULL marker.
UPDATE user_profiles
SET    signup_conversion_fired_at = now()
WHERE  signup_conversion_fired_at IS NULL;

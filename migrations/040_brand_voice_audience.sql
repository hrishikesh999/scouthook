-- 040_brand_voice_audience.sql
-- Revamps Voice DNA to structured Brand Voice + Audience profiles.
-- Drops 7 legacy flat fields, adds 11 Brand Voice + 7 Audience columns.
-- No live users — clean migration, no data seeding needed.

-- Drop legacy fields replaced by richer structured equivalents
ALTER TABLE profiles
  DROP COLUMN IF EXISTS content_niche,
  DROP COLUMN IF EXISTS business_positioning,
  DROP COLUMN IF EXISTS contrarian_view,
  DROP COLUMN IF EXISTS onboarding_q1,
  DROP COLUMN IF EXISTS audience_role,
  DROP COLUMN IF EXISTS audience_pain,
  DROP COLUMN IF EXISTS goal;

-- Brand Voice columns
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS brand_description            text,
  ADD COLUMN IF NOT EXISTS brand_industry               varchar(100),
  ADD COLUMN IF NOT EXISTS brand_personality_traits     text,
  ADD COLUMN IF NOT EXISTS brand_emotional_tone         varchar(50),
  ADD COLUMN IF NOT EXISTS elevator_main_result         text,
  ADD COLUMN IF NOT EXISTS elevator_mechanism           text,
  ADD COLUMN IF NOT EXISTS brand_archetype              varchar(50),
  ADD COLUMN IF NOT EXISTS brand_core_beliefs           text,
  ADD COLUMN IF NOT EXISTS brand_phrases_to_use         text,
  ADD COLUMN IF NOT EXISTS brand_story_origin           text,
  ADD COLUMN IF NOT EXISTS brand_voice_profile_json     text;

-- Audience columns
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS audience_description         text,
  ADD COLUMN IF NOT EXISTS audience_goals               text,
  ADD COLUMN IF NOT EXISTS audience_obstacles           text,
  ADD COLUMN IF NOT EXISTS audience_core_beliefs_market text,
  ADD COLUMN IF NOT EXISTS audience_buying_stage        varchar(50),
  ADD COLUMN IF NOT EXISTS audience_market_sophistication varchar(20),
  ADD COLUMN IF NOT EXISTS audience_profile_json        text;

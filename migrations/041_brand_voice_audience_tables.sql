-- Migration 041: Extract brand voice + audience fields into dedicated tables.
-- Drops the 18 columns added to profiles in migration 040 and moves them into
-- brand_voice_profiles and audience_profiles (1:1 with profiles via profile_id FK).

-- Brand Voice ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brand_voice_profiles (
  id                       bigserial PRIMARY KEY,
  profile_id               bigint NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  brand_description        text,
  brand_industry           varchar(100),
  brand_personality_traits text,             -- JSON array
  brand_emotional_tone     varchar(50),
  elevator_main_result     text,
  elevator_mechanism       text,
  brand_archetype          varchar(50),
  brand_core_beliefs       text,             -- JSON array
  brand_phrases_to_use     text,             -- JSON array
  brand_story_origin       text,
  brand_voice_profile_json text,             -- cached AI output
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_bvp_profile UNIQUE (profile_id)
);
CREATE INDEX IF NOT EXISTS idx_bvp_profile ON brand_voice_profiles(profile_id);

-- Audience ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audience_profiles (
  id                             bigserial PRIMARY KEY,
  profile_id                     bigint NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  audience_description           text,
  audience_goals                 text,       -- JSON array
  audience_obstacles             text,       -- JSON array
  audience_core_beliefs_market   text,       -- JSON array
  audience_buying_stage          varchar(50),
  audience_market_sophistication varchar(20),
  audience_profile_json          text,       -- cached AI output
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_audp_profile UNIQUE (profile_id)
);
CREATE INDEX IF NOT EXISTS idx_audp_profile ON audience_profiles(profile_id);

-- Drop 18 columns from profiles (added in migration 040) ----------------------
ALTER TABLE profiles
  DROP COLUMN IF EXISTS brand_description,
  DROP COLUMN IF EXISTS brand_industry,
  DROP COLUMN IF EXISTS brand_personality_traits,
  DROP COLUMN IF EXISTS brand_emotional_tone,
  DROP COLUMN IF EXISTS elevator_main_result,
  DROP COLUMN IF EXISTS elevator_mechanism,
  DROP COLUMN IF EXISTS brand_archetype,
  DROP COLUMN IF EXISTS brand_core_beliefs,
  DROP COLUMN IF EXISTS brand_phrases_to_use,
  DROP COLUMN IF EXISTS brand_story_origin,
  DROP COLUMN IF EXISTS brand_voice_profile_json,
  DROP COLUMN IF EXISTS audience_description,
  DROP COLUMN IF EXISTS audience_goals,
  DROP COLUMN IF EXISTS audience_obstacles,
  DROP COLUMN IF EXISTS audience_core_beliefs_market,
  DROP COLUMN IF EXISTS audience_buying_stage,
  DROP COLUMN IF EXISTS audience_market_sophistication,
  DROP COLUMN IF EXISTS audience_profile_json;

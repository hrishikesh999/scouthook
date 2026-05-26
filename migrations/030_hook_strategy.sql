-- Migration 030: Phase 7 — Personalized Hook Strategy
-- content_pillars: JSON array of 2-3 topic focus areas derived from niche + onboarding Q&A.
-- user_archetype_preference: JSON object mapping archetype name → publish count, e.g. {"CONFESSION":5,"BEFORE_AFTER":3}.

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS content_pillars TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS user_archetype_preference TEXT;

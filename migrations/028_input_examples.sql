-- Migration 028: Phase 3 — Smarter Generate Page Input
-- Adds input_examples to store niche-specific textarea placeholder examples.
-- Generated once at onboarding completion via Haiku (non-blocking).
-- JSON array of 3-4 example strings tailored to the user's content_niche and audience_role.

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS input_examples TEXT;

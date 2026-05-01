-- Migration 015: add website_url to user_profiles for onboarding website extraction
ALTER TABLE user_profiles ADD COLUMN website_url TEXT;

-- Migration 013: Onboarding wizard support
-- Adds user_role (which type of professional the user is) and
-- onboarding_complete flag so first-time users are routed to the wizard.

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS user_role TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS onboarding_complete INTEGER DEFAULT 0;

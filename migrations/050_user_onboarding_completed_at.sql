-- Track first-time onboarding completion at the user level, independent of any
-- specific workspace. Once set, the 7-step onboarding wizard never fires again
-- for this user, even when they create additional workspaces.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

-- Backfill: any user who has at least one workspace with a completed profile
-- has already done first-time onboarding.
UPDATE user_profiles up
SET onboarding_completed_at = now()
WHERE onboarding_completed_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM workspace_members wm
    JOIN profiles p ON p.workspace_id = wm.workspace_id
    WHERE wm.user_id = up.user_id
      AND p.is_default = true
      AND p.onboarding_complete = true
  );

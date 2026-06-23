-- Backfill onboarding_completed_at for users who already have a complete workspace.
-- This fixes the onboarding-loop bug for users who signed up before migration 050
-- added the column (it was never written for them, so the flag reads as false and
-- the callback keeps redirecting them to /onboarding.html on every login).

UPDATE user_profiles
SET    onboarding_completed_at = COALESCE(created_at, now())
WHERE  onboarding_completed_at IS NULL
  AND  EXISTS (
         SELECT 1
         FROM   workspace_members wm
         JOIN   workspaces w ON w.id = wm.workspace_id
         JOIN   profiles p   ON p.workspace_id = w.id
         WHERE  wm.user_id = user_profiles.user_id
           AND  p.is_default = true
           AND  p.onboarding_complete = true
           AND  w.deleted_at IS NULL
       );

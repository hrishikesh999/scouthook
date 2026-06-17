-- Migration 038: Track last active workspace per user.
-- Login resolution uses this instead of "oldest workspace" so a workspace switch
-- (or admin override) persists across re-logins and session expiry.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS last_active_workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL;

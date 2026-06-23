-- 053_workspace_schema_hardening.sql
-- Schema hardening for workspace tables identified in workspace audit.

-- SCHEMA-1: Enforce valid role values at the DB level.
-- Application code validates 'owner' | 'editor' but lacked a DB constraint.
ALTER TABLE workspace_members
  ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN ('owner', 'editor'));

-- SCHEMA-3: Expression index for case-insensitive email lookups on workspace_invites.
-- Speeds up the "already a member?" join and "pending invite?" duplicate check
-- in POST /api/workspaces/:id/invites (both use LOWER(email) comparisons).
CREATE INDEX IF NOT EXISTS idx_workspace_invites_email
  ON workspace_invites (LOWER(email));

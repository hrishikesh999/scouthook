-- 082_linkedin_scope_split.sql
-- Onboarding asks for `openid profile` only, so a connection can exist that is
-- allowed to read the member's name/photo/headline but NOT to publish. The write
-- scope (w_member_social) is requested separately at the first publish attempt.
--
-- `scopes` records what LinkedIn actually granted, so publish paths can tell a
-- read-only connection apart from a full one instead of assuming every row can post.
--
-- Backfill: every connection that existed before this migration was created by the
-- old single-ask flow, which always requested w_member_social — so they are all
-- publish-capable and must be marked as such, or existing users lose the ability
-- to publish the moment this ships.
ALTER TABLE linkedin_connections
  ADD COLUMN IF NOT EXISTS scopes text;

UPDATE linkedin_connections
   SET scopes = 'openid profile w_member_social'
 WHERE scopes IS NULL;

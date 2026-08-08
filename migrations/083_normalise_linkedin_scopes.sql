-- 083_normalise_linkedin_scopes.sql
-- Repair scope strings stored with LinkedIn's separator instead of ours.
--
-- The two ends of the same OAuth handshake disagree: the authorization request
-- takes scopes space-separated ("openid profile w_member_social"), and the token
-- response echoes what was granted COMMA-separated ("openid,profile,w_member_social").
-- Migration 082 added this column and the callback stored the token response
-- verbatim, while every reader split on whitespace only. So a connection that had
-- genuinely been granted w_member_social read back as read-only: the user granted
-- publishing, we recorded it, and then failed to parse our own record. Symptom was
-- "connected, still can't publish", surviving any number of reconnects because each
-- one wrote the same unparseable string again.
--
-- The readers now accept both separators, so this migration is not what unblocks
-- publishing — it normalises the column so its contents are consistent and a human
-- reading a row sees one format. Only commas are rewritten; nothing is added or
-- removed, so a genuinely read-only connection stays read-only.
UPDATE linkedin_connections
   SET scopes = btrim(regexp_replace(replace(scopes, ',', ' '), '\s+', ' ', 'g'))
 WHERE scopes IS NOT NULL
   AND scopes <> btrim(regexp_replace(replace(scopes, ',', ' '), '\s+', ' ', 'g'));

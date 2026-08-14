-- 086_linkedin_connection_health.sql
--
-- Until now the only thing that made a connection look dead was `expires_at`
-- passing. That misses the case users actually hit: LinkedIn revoking the token
-- early (the member removes ScoutHook under Settings → Data privacy → Permitted
-- services, changes their password, or trips a security check). Revocation kills
-- the access AND refresh token immediately while `expires_at` still reads months
-- out, so every gate in the app — /api/linkedin/status, the publish check, the
-- schedule check — kept reporting a healthy connection and the first sign of
-- trouble was a raw 401 in the user's face mid-publish.
--
-- These columns record connection health as an observed fact rather than an
-- inference from a date:
--   needs_reconnect_at — set when LinkedIn tells us the token is dead (401 /
--                        REVOKED_ACCESS_TOKEN). NULL means healthy. Cleared on a
--                        successful re-auth or any successful API call.
--   last_verified_at   — when we last saw LinkedIn accept this token.
--   last_error         — the classified reason, for support and admin triage.
--
-- Existing rows start NULL/healthy: absence of evidence that a token is dead is
-- the correct default. The daily sweep and the login probe will flag the genuinely
-- revoked ones within a day, and nobody loses publishing in the meantime.
ALTER TABLE linkedin_connections
  ADD COLUMN IF NOT EXISTS needs_reconnect_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_verified_at   timestamptz,
  ADD COLUMN IF NOT EXISTS last_error         text;

-- The daily sweep scans for healthy connections to probe; the status/publish
-- gates ask the opposite question about a single row. A partial index on the
-- unhealthy rows keeps the admin/"who needs reconnecting" query cheap without
-- carrying an index entry for every healthy connection.
CREATE INDEX IF NOT EXISTS idx_linkedin_connections_needs_reconnect
  ON linkedin_connections (workspace_id)
  WHERE needs_reconnect_at IS NOT NULL;

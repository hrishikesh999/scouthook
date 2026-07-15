-- MCP personal access tokens (see docs/mcp-server-plan.md).
-- Phase-0/1 auth for the ScoutHook MCP server: a user mints a token in ScoutHook
-- and pastes it into Claude as a custom-connector bearer token. Each token is
-- bound to one user_id + tenant_id — the MCP endpoint derives identity from the
-- token exactly like the web app derives it from the session, so a token can
-- never reach another workspace's data.
--
-- Only the SHA-256 hash of the raw token is stored; the raw value is shown once
-- at mint time and is unrecoverable afterwards. When OAuth ships (plan Phase 3)
-- this table remains the fallback "personal token" path.

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id            bigserial PRIMARY KEY,
  token_hash    text NOT NULL UNIQUE,          -- sha256(raw token), hex
  token_prefix  text NOT NULL,                 -- first chars of raw token, for display only
  user_id       text NOT NULL,
  tenant_id     text NOT NULL,
  label         text,                          -- user-facing name, e.g. "Claude on my laptop"
  scopes        text NOT NULL DEFAULT 'read',  -- 'read' | 'read,write' (write tools land in plan Phase 2)
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

-- Hot path: verify a presented token. Partial index keeps revoked rows out.
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_hash_active
  ON mcp_tokens (token_hash) WHERE revoked_at IS NULL;

-- Listing a user's tokens in settings.
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_owner
  ON mcp_tokens (user_id, tenant_id);

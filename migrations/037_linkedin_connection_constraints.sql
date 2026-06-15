-- Migration 037: Enforce at most one default LinkedIn connection per workspace per account type.
-- Cleans up any pre-existing duplicates first (keeps the oldest), then adds a partial unique index.

-- Step 1: Deduplicate — if multiple is_default=true rows exist for the same
-- (workspace_id, account_type), keep only the earliest-created one.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY workspace_id, account_type
           ORDER BY created_at ASC
         ) AS rn
  FROM linkedin_connections
  WHERE is_default = true
)
UPDATE linkedin_connections
SET is_default = false, updated_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Step 2: Partial unique index — DB now enforces the invariant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_connections_one_default
  ON linkedin_connections (workspace_id, account_type)
  WHERE is_default = true;

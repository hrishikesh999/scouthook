# Deploy Runbook — Migration 036 (Workspaces + Profiles)

This document covers the one-time migration from the single-tenant schema
(`user_profiles` + `linkedin_tokens`) to the multi-workspace schema
(`workspaces` + `profiles` + `linkedin_connections`).

**Estimated downtime:** 3–5 minutes.
**Best time:** lowest-traffic window (weekday early morning).

---

## Pre-migration checklist (run in order)

### 1. Disable scheduling

```sql
UPDATE platform_settings SET value = 'false' WHERE key = 'scheduling_enabled';
```

### 2. Wait for the BullMQ queue to drain

Poll until this returns 0:

```sql
SELECT COUNT(*) FROM scheduled_posts WHERE status = 'processing';
```

Maximum wait: 20 minutes. The stuck-post recovery job resets any stuck rows after 20 min.
If still non-zero after 20 min, the migration's abort guard will catch it (see below).

### 3. Verify queue is empty

```sql
SELECT COUNT(*) FROM scheduled_posts WHERE status = 'processing';
-- Must be 0 before continuing.
```

---

## Migration

### 4. Run migration 036

```bash
node scripts/migrate.js  # or however your migration runner is invoked
# -- or direct psql:
psql "$DATABASE_URL" -f migrations/036_workspaces_and_profiles.sql
```

The migration includes an abort guard at the top:

```sql
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM scheduled_posts WHERE status = 'processing') THEN
    RAISE EXCEPTION 'Migration aborted: ...';
  END IF;
END $$;
```

If it raises, fix the queue and retry from step 1.

**What migration 036 does:**
- Creates `auth_providers`, `workspaces`, `workspace_members`, `workspace_invites`,
  `profiles`, `linkedin_connections` tables
- Migrates every existing user → personal workspace + brand profile + linkedin_connection
- Re-tenants all content tables (`generated_posts`, `scheduled_posts`, `vault_*`, etc.)
  from `tenant_id='default'` to the new workspace UUIDs
- Strips voice DNA columns from `user_profiles` (leaves identity only)
- Drops `linkedin_tokens` table
- Invalidates all sessions (`DELETE FROM session`) — users re-authenticate on next visit

---

## Code deploy

### 5. Deploy the new application code

Deploy Sprint 1 code simultaneously with (or immediately after) the migration.

**Critical:** do NOT deploy new code before migration 036. The new code uses
`req.tenantId` as a workspace UUID. Old sessions have `tenant_id='default'`.
Migration's `DELETE FROM session` ensures all sessions are fresh post-deploy.

Deploy order guarantee:
1. Run migration 036 (sessions wiped, `linkedin_tokens` dropped)
2. Deploy new code
3. First login after deploy creates/resolves workspace UUID → fresh session

### 6. Verify linkedin_connections migrated

```sql
SELECT COUNT(*) FROM linkedin_connections;
-- Should be > 0 if any users had LinkedIn connected
```

### 7. Verify workspace + profile creation

```sql
SELECT COUNT(*) FROM workspaces;
SELECT COUNT(*) FROM profiles WHERE is_default = true;
-- Should match user count
```

### 8. Re-enable scheduling

```sql
UPDATE platform_settings SET value = 'true' WHERE key = 'scheduling_enabled';
```

---

## Rate limit key change (Trap 11)

The generation rate limit key changes from `gen_ratelimit:${userId}` (old) to
`gen_ratelimit:${tenantId}` (new workspace UUID). Old Redis keys are orphaned but
harmless — they expire within 1 hour. No manual Redis cleanup needed.

**The dangerous window** (shared `gen_ratelimit:default` key for all users) is
eliminated by the deploy order above: sessions are wiped in step 1, so no user
can hit the new code with an old `tenant_id='default'` session.

---

## Rollback (if needed)

Migration 036 is not automatically reversible (it drops `linkedin_tokens` and
strips columns from `user_profiles`). If you need to roll back:

1. Restore from the pre-migration database snapshot
2. Deploy the previous application code tag
3. Re-enable scheduling

Always take a full database snapshot immediately before step 4 above.

---

## Post-deploy verification checklist

Run these queries to confirm the migration succeeded:

```sql
-- 1. All users have a workspace
SELECT COUNT(*) FROM user_profiles up
LEFT JOIN workspace_members wm ON wm.user_id = up.user_id
WHERE wm.workspace_id IS NULL;
-- Expect: 0

-- 2. All workspaces have exactly one default profile
SELECT workspace_id, COUNT(*) FROM profiles WHERE is_default = true GROUP BY workspace_id HAVING COUNT(*) != 1;
-- Expect: 0 rows

-- 3. Content re-tenanted (no rows left on 'default')
SELECT COUNT(*) FROM generated_posts WHERE tenant_id = 'default';
SELECT COUNT(*) FROM vault_documents WHERE tenant_id = 'default';
-- Expect: 0

-- 4. linkedin_tokens gone
SELECT to_regclass('public.linkedin_tokens');
-- Expect: null (table dropped)
```

Additionally, log in as a real user and verify:
- Land on dashboard for personal workspace
- All posts visible
- LinkedIn connection status visible in workspace settings
- Can generate a post
- Workspace switcher appears in sidebar (single workspace until more are created)

---

## Sprint 3 Pre-Deploy Checklist

Sprint 3 rewrites `routes/linkedin.js`, `services/linkedinPublisher.js`, and
`services/linkedinOAuth.js` to use `linkedin_connections` instead of `linkedin_tokens`.
`linkedin_tokens` is dropped by migration 036. Any remaining reference to it in code
will crash at runtime.

**Required gate — must pass before deploying Sprint 3:**

```bash
grep -rn "linkedin_tokens" routes/ services/ workers/ server.js
# Must return zero results. If non-zero, fix all hits before deploying.
```

Files expected to be clean after Sprint 3:
- `routes/linkedin.js` — replace all `linkedin_tokens` queries with `linkedin_connections`
- `routes/checklist.js` — replace LinkedIn check with `linkedin_connections WHERE workspace_id=?`
- `routes/visuals.js` — replace avatar fetch with `linkedin_connections WHERE workspace_id=?`
- `services/linkedinPublisher.js` — all token lookups via `linkedin_connections`
- `services/linkedinOAuth.js` — rewrite to upsert `linkedin_connections`

Also verify:
```bash
grep -rn "FROM user_profiles" routes/vault.js routes/visuals.js
# Must return zero results post-Sprint-2.
```

-- 036_workspaces_and_profiles.sql
-- Sprint 1: Workspaces, Profiles, Multi-LinkedIn
-- See /Users/hrishi/.claude/plans/currently-in-scouthoo-user-linear-teapot.md for full design

-- ============================================================
-- GUARD: abort if any scheduled posts are still processing
-- (drain BullMQ queue before running this migration)
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM scheduled_posts WHERE status = 'processing') THEN
    RAISE EXCEPTION 'Migration aborted: % scheduled posts still processing. Drain queue first.',
      (SELECT COUNT(*) FROM scheduled_posts WHERE status = 'processing');
  END IF;
END $$;

-- ============================================================
-- STEP 0: auth_providers — stable identity layer
-- Decouples user_id from auth provider; enables email/password auth.
-- ============================================================
CREATE TABLE auth_providers (
  id                bigserial PRIMARY KEY,
  user_id           text NOT NULL,
  provider          text NOT NULL,         -- 'google' | 'email'
  provider_id       text NOT NULL,         -- Google sub ID or email address
  credential_hash   text,
  verified_at       timestamptz,
  verify_token      text,
  verify_expires_at timestamptz,
  reset_token       text,
  reset_expires_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_id)
);
CREATE INDEX idx_auth_providers_user_id ON auth_providers(user_id);

-- Pre-populate from existing Google users (preserves current user_id format)
INSERT INTO auth_providers (user_id, provider, provider_id)
SELECT user_id, 'google', REPLACE(user_id, 'google:', '')
FROM user_profiles;

-- ============================================================
-- STEP 1: New tables
-- ============================================================
CREATE TABLE workspaces (
  id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name             text NOT NULL,
  created_by       text NOT NULL,
  brand_name       text,
  brand_logo       text,
  brand_bg         text DEFAULT '#0F1A3C',
  brand_accent     text DEFAULT '#0D7A5F',
  brand_text       text DEFAULT '#F0F4FF',
  grace_expires_at timestamptz,
  deleted_at       timestamptz,
  purge_at         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  id            bigserial PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  role          text NOT NULL DEFAULT 'editor',
  invited_by    text,
  joined_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);
CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);

CREATE TABLE workspace_invites (
  id            bigserial PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email         text NOT NULL,
  role          text NOT NULL DEFAULT 'editor',
  token         text NOT NULL UNIQUE,
  invited_by    text NOT NULL,
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profiles (
  id              bigserial PRIMARY KEY,
  workspace_id    text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_type    text NOT NULL DEFAULT 'person',   -- 'brand' | 'person'
  display_name    text NOT NULL,
  avatar_url      text,
  is_default      boolean NOT NULL DEFAULT false,
  -- Positioning
  business_positioning  text,
  website_url           text,
  website_summary       text,
  website_extracted_at  timestamptz,
  website_articles_text text,
  content_niche         text,
  audience_role         text,
  audience_pain         text,
  goal                  text,
  contrarian_view       text,
  -- Onboarding inputs
  writing_samples           text,
  writing_sample_phrases    text,
  onboarding_q1             text,
  onboarding_q2             text,
  onboarding_q3             text,
  onboarding_q_completed_at timestamptz,
  onboarding_completed_at   timestamptz,
  onboarding_complete       boolean NOT NULL DEFAULT false,
  -- Extracted voice DNA
  voice_fingerprint         text,
  authority_statements      text,
  banned_patterns           text,
  content_principles        text,
  content_themes            text,
  content_pillars           text,
  cta_library               text,
  voice_refinements         text,
  user_archetype_preference text,
  input_examples            text,
  -- Metadata
  voice_extraction_source      varchar(20),
  voice_extraction_quality     varchar(10),
  voice_profile_completion_pct int DEFAULT 0,
  voice_profile_completed_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_profiles_workspace ON profiles(workspace_id);
-- Exactly one default profile per workspace (Trap 8)
CREATE UNIQUE INDEX idx_profiles_one_default ON profiles(workspace_id) WHERE is_default = true;

CREATE TABLE linkedin_connections (
  id                 bigserial PRIMARY KEY,
  workspace_id       text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id         bigint NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  authorized_by      text NOT NULL,
  account_type       text NOT NULL DEFAULT 'personal',  -- 'personal' | 'company'
  account_key        text NOT NULL,   -- 'person_{member_id}' | 'org_{org_id}'
  display_name       text,
  avatar_url         text,
  linkedin_member_id text,
  organization_id    text,
  access_token_enc   text NOT NULL,
  refresh_token_enc  text,
  expires_at         timestamptz NOT NULL,
  is_default         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, account_key)
);
CREATE INDEX idx_linkedin_connections_workspace ON linkedin_connections(workspace_id);
CREATE INDEX idx_linkedin_connections_profile   ON linkedin_connections(profile_id);

-- ============================================================
-- STEP 2: user_subscriptions additions
-- ============================================================
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS extra_workspaces integer NOT NULL DEFAULT 0;
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
-- Reject unknown plan values at DB level (Trap 10)
ALTER TABLE user_subscriptions ADD CONSTRAINT chk_plan_values
  CHECK (plan IN ('free', 'solo', 'pro'));

-- ============================================================
-- STEP 3: Data migration — one personal workspace per existing user
--
-- CTE chain: workspaces → members → brand profiles → linkedin_connections
-- All four INSERT CTEs execute atomically when the final SELECT runs.
-- ============================================================
WITH src AS (
  SELECT
    up.*,
    lt.linkedin_user_id,
    lt.linkedin_name,
    lt.linkedin_photo,
    lt.access_token_enc   AS lt_access_token_enc,
    lt.refresh_token_enc  AS lt_refresh_token_enc,
    lt.expires_at         AS lt_expires_at
  FROM user_profiles up
  LEFT JOIN linkedin_tokens lt
    ON lt.user_id = up.user_id AND lt.tenant_id = 'default'
  WHERE up.tenant_id = 'default'
),
new_workspaces AS (
  INSERT INTO workspaces
    (id, name, created_by, brand_name, brand_logo, brand_bg, brand_accent, brand_text)
  SELECT
    gen_random_uuid()::text,
    COALESCE(brand_name, display_name, 'My Workspace'),
    user_id,
    brand_name,
    brand_logo,
    COALESCE(brand_bg, '#0F1A3C'),
    COALESCE(brand_accent, '#0D7A5F'),
    COALESCE(brand_text, '#F0F4FF')
  FROM src
  RETURNING id, created_by
),
new_members AS (
  INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
  SELECT id, created_by, 'owner', now()
  FROM new_workspaces
),
new_profiles AS (
  INSERT INTO profiles (
    workspace_id, profile_type, display_name, is_default,
    business_positioning, website_url, website_summary, website_extracted_at,
    website_articles_text, content_niche, audience_role, audience_pain, goal, contrarian_view,
    writing_samples, writing_sample_phrases, onboarding_q1, onboarding_q2, onboarding_q3,
    onboarding_q_completed_at, onboarding_completed_at, onboarding_complete,
    voice_fingerprint, authority_statements, banned_patterns, content_principles,
    content_themes, content_pillars, cta_library, voice_refinements,
    user_archetype_preference, input_examples, voice_extraction_source,
    voice_extraction_quality, voice_profile_completion_pct, voice_profile_completed_at
  )
  SELECT
    nw.id,
    'brand',
    COALESCE(s.brand_name, s.display_name, 'Brand'),
    true,
    s.business_positioning, s.website_url, s.website_summary, s.website_extracted_at,
    s.website_articles_text, s.content_niche, s.audience_role, s.audience_pain, s.goal, s.contrarian_view,
    s.writing_samples, s.writing_sample_phrases, s.onboarding_q1, s.onboarding_q2, s.onboarding_q3,
    s.onboarding_q_completed_at, s.onboarding_completed_at, (s.onboarding_complete = 1),
    s.voice_fingerprint, s.authority_statements, s.banned_patterns, s.content_principles,
    s.content_themes, s.content_pillars, s.cta_library, s.voice_refinements,
    s.user_archetype_preference, s.input_examples, s.voice_extraction_source,
    s.voice_extraction_quality, s.voice_profile_completion_pct, s.voice_profile_completed_at
  FROM src s
  JOIN new_workspaces nw ON nw.created_by = s.user_id
  RETURNING id, workspace_id
),
new_connections AS (
  INSERT INTO linkedin_connections (
    workspace_id, profile_id, authorized_by, account_type, account_key,
    display_name, avatar_url, linkedin_member_id,
    access_token_enc, refresh_token_enc, expires_at, is_default
  )
  SELECT
    nw.id,
    np.id,
    s.user_id,
    'personal',
    'person_' || s.linkedin_user_id,
    s.linkedin_name,
    s.linkedin_photo,
    s.linkedin_user_id,
    s.lt_access_token_enc,
    s.lt_refresh_token_enc,
    s.lt_expires_at,
    true
  FROM src s
  JOIN new_workspaces nw ON nw.created_by = s.user_id
  JOIN new_profiles   np ON np.workspace_id = nw.id
  WHERE s.linkedin_user_id IS NOT NULL
  RETURNING id
)
SELECT COUNT(*) FROM new_connections;

-- ============================================================
-- STEP 4: Re-tenant all content tables to new workspace UUIDs
-- (Trap 2 fix: join real tables, not CTE alias which is out of scope)
-- ============================================================
UPDATE generated_posts SET tenant_id = w.id
FROM workspaces w
JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.role = 'owner'
WHERE generated_posts.user_id = wm.user_id
  AND generated_posts.tenant_id = 'default';

UPDATE scheduled_posts SET tenant_id = w.id
FROM workspaces w
JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.role = 'owner'
WHERE scheduled_posts.user_id = wm.user_id
  AND scheduled_posts.tenant_id = 'default';

UPDATE vault_documents SET tenant_id = w.id
FROM workspaces w
JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.role = 'owner'
WHERE vault_documents.user_id = wm.user_id
  AND vault_documents.tenant_id = 'default';

UPDATE vault_chunks SET tenant_id = w.id
FROM workspaces w
JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.role = 'owner'
WHERE vault_chunks.user_id = wm.user_id
  AND vault_chunks.tenant_id = 'default';

UPDATE vault_ideas SET tenant_id = w.id
FROM workspaces w
JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.role = 'owner'
WHERE vault_ideas.user_id = wm.user_id
  AND vault_ideas.tenant_id = 'default';

UPDATE generation_runs SET tenant_id = w.id
FROM workspaces w
JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.role = 'owner'
WHERE generation_runs.user_id = wm.user_id
  AND generation_runs.tenant_id = 'default';

UPDATE copy_events SET tenant_id = w.id
FROM workspaces w
JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.role = 'owner'
WHERE copy_events.user_id = wm.user_id
  AND copy_events.tenant_id = 'default';

UPDATE media_files SET tenant_id = w.id
FROM workspaces w
JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.role = 'owner'
WHERE media_files.user_id = wm.user_id
  AND media_files.tenant_id = 'default';

UPDATE scheduled_post_events SET tenant_id = w.id
FROM workspaces w
JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.role = 'owner'
WHERE scheduled_post_events.user_id = wm.user_id
  AND scheduled_post_events.tenant_id = 'default';

-- ============================================================
-- STEP 5: Add profile_id to generated_posts and scheduled_posts
-- ============================================================
ALTER TABLE generated_posts ADD COLUMN profile_id bigint REFERENCES profiles(id);
ALTER TABLE scheduled_posts ADD COLUMN profile_id bigint REFERENCES profiles(id);

-- Backfill: each post gets the workspace's default (brand) profile
UPDATE generated_posts gp
SET profile_id = p.id
FROM profiles p
WHERE p.workspace_id = gp.tenant_id AND p.is_default = true;

UPDATE scheduled_posts sp
SET profile_id = p.id
FROM profiles p
WHERE p.workspace_id = sp.tenant_id AND p.is_default = true;

-- ============================================================
-- STEP 6: FK constraints — content tables → workspaces
-- ============================================================
ALTER TABLE generated_posts
  ADD CONSTRAINT fk_gp_ws FOREIGN KEY (tenant_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE scheduled_posts
  ADD CONSTRAINT fk_sp_ws FOREIGN KEY (tenant_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE vault_documents
  ADD CONSTRAINT fk_vd_ws FOREIGN KEY (tenant_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE vault_chunks
  ADD CONSTRAINT fk_vc_ws FOREIGN KEY (tenant_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE vault_ideas
  ADD CONSTRAINT fk_vi_ws FOREIGN KEY (tenant_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE generation_runs
  ADD CONSTRAINT fk_gr_ws FOREIGN KEY (tenant_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE copy_events
  ADD CONSTRAINT fk_ce_ws FOREIGN KEY (tenant_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE media_files
  ADD CONSTRAINT fk_mf_ws FOREIGN KEY (tenant_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE scheduled_post_events
  ADD CONSTRAINT fk_spe_ws FOREIGN KEY (tenant_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- ============================================================
-- STEP 7: Workspace-leading indexes for new query pattern (Trap 6)
-- Without CONCURRENTLY because we're inside a transaction
-- ============================================================
CREATE INDEX idx_generated_posts_tenant      ON generated_posts(tenant_id, created_at DESC);
CREATE INDEX idx_scheduled_posts_tenant      ON scheduled_posts(tenant_id, status);
CREATE INDEX idx_generation_runs_tenant      ON generation_runs(tenant_id, created_at DESC);
CREATE INDEX idx_vault_documents_tenant      ON vault_documents(tenant_id, created_at DESC);
CREATE INDEX idx_vault_ideas_tenant          ON vault_ideas(tenant_id);
CREATE INDEX idx_vault_chunks_tenant         ON vault_chunks(tenant_id);
CREATE INDEX idx_copy_events_tenant          ON copy_events(tenant_id);
CREATE INDEX idx_media_files_tenant          ON media_files(tenant_id, created_at DESC);

-- ============================================================
-- STEP 8: Strip user_profiles down to identity only
-- Keep: id, user_id, email, display_name, user_role, created_at, updated_at
-- ============================================================
ALTER TABLE user_profiles
  DROP COLUMN tenant_id,
  DROP COLUMN brand_name,
  DROP COLUMN brand_logo,
  DROP COLUMN brand_bg,
  DROP COLUMN brand_accent,
  DROP COLUMN brand_text,
  DROP COLUMN writing_samples,
  DROP COLUMN writing_sample_phrases,
  DROP COLUMN contrarian_view,
  DROP COLUMN audience_role,
  DROP COLUMN audience_pain,
  DROP COLUMN content_niche,
  DROP COLUMN voice_fingerprint,
  DROP COLUMN voice_refinements,
  DROP COLUMN authority_statements,
  DROP COLUMN banned_patterns,
  DROP COLUMN content_principles,
  DROP COLUMN content_themes,
  DROP COLUMN cta_library,
  DROP COLUMN business_positioning,
  DROP COLUMN website_url,
  DROP COLUMN website_summary,
  DROP COLUMN website_extracted_at,
  DROP COLUMN website_articles_text,
  DROP COLUMN goal,
  DROP COLUMN onboarding_q1,
  DROP COLUMN onboarding_q2,
  DROP COLUMN onboarding_q3,
  DROP COLUMN onboarding_q_completed_at,
  DROP COLUMN onboarding_completed_at,
  DROP COLUMN onboarding_complete,
  DROP COLUMN voice_extraction_source,
  DROP COLUMN voice_extraction_quality,
  DROP COLUMN voice_profile_completion_pct,
  DROP COLUMN voice_profile_completed_at,
  DROP COLUMN content_pillars,
  DROP COLUMN user_archetype_preference,
  DROP COLUMN input_examples,
  DROP COLUMN ghostwriter_prompt,
  DROP COLUMN ghostwriter_prompt_built_at;

-- Dropping tenant_id above auto-removes user_profiles_user_id_tenant_id_key.
-- Add the new user_id-only unique constraint.
ALTER TABLE user_profiles ADD CONSTRAINT user_profiles_user_id_key UNIQUE (user_id);

-- ============================================================
-- STEP 9: Invalidate all existing sessions
-- (tenant_id='default' in session is now stale)
-- ============================================================
DELETE FROM session;

-- ============================================================
-- STEP 10: Drop obsolete tables
-- ============================================================
DROP TABLE linkedin_tokens;
DROP TABLE tenant_settings;

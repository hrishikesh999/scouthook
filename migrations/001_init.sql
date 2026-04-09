-- Initial schema for Postgres (Neon)

CREATE TABLE IF NOT EXISTS schema_migrations (
  id            bigserial PRIMARY KEY,
  filename      text NOT NULL UNIQUE,
  applied_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_settings (
  key        text PRIMARY KEY,
  value      text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_settings (
  id         bigserial PRIMARY KEY,
  tenant_id  text NOT NULL,
  key        text NOT NULL,
  value      text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS user_profiles (
  id                bigserial PRIMARY KEY,
  user_id           text NOT NULL,
  tenant_id         text NOT NULL DEFAULT 'default',
  writing_samples   text,
  contrarian_view   text,
  audience_role     text,
  audience_pain     text,
  content_niche     text,
  voice_fingerprint text,
  brand_bg          text DEFAULT '#0F1A3C',
  brand_accent      text DEFAULT '#0D7A5F',
  brand_text        text DEFAULT '#F0F4FF',
  brand_name        text,
  brand_logo        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles (user_id, tenant_id);

CREATE TABLE IF NOT EXISTS post_formats (
  id                  bigserial PRIMARY KEY,
  tenant_id           text NOT NULL DEFAULT 'default',
  slug                text NOT NULL,
  name                text NOT NULL,
  description         text,
  prompt_instructions text,
  is_active           integer DEFAULT 1,
  sort_order          integer DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug, tenant_id)
);

CREATE TABLE IF NOT EXISTS recipes (
  id               bigserial PRIMARY KEY,
  tenant_id        text NOT NULL DEFAULT 'default',
  slug             text NOT NULL,
  name             text NOT NULL,
  category         text NOT NULL,
  description      text,
  questions        text NOT NULL,
  suggested_visual text,
  suitable_formats text,
  is_active        integer DEFAULT 1,
  sort_order       integer DEFAULT 0,
  UNIQUE (slug, tenant_id)
);

CREATE TABLE IF NOT EXISTS generation_runs (
  id         bigserial PRIMARY KEY,
  user_id    text NOT NULL,
  tenant_id  text NOT NULL DEFAULT 'default',
  path       text NOT NULL,
  input_data text,
  synthesis  text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_generation_runs_user_id ON generation_runs (user_id, tenant_id);

CREATE TABLE IF NOT EXISTS generated_posts (
  id              bigserial PRIMARY KEY,
  run_id          bigint NOT NULL REFERENCES generation_runs(id),
  user_id         text NOT NULL,
  tenant_id       text NOT NULL DEFAULT 'default',
  format_slug     text NOT NULL,
  content         text NOT NULL,
  quality_score   integer,
  quality_flags   text,
  passed_gate     integer DEFAULT 0,
  status          text NOT NULL DEFAULT 'draft',
  published_at    timestamptz,
  idea_input      text,
  linkedin_post_id text,
  likes           integer DEFAULT 0,
  comments        integer DEFAULT 0,
  reactions       integer DEFAULT 0,
  last_synced_at  timestamptz,
  asset_type      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS copy_events (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL,
  tenant_id   text NOT NULL DEFAULT 'default',
  post_id     bigint REFERENCES generated_posts(id),
  run_id      bigint REFERENCES generation_runs(id),
  path        text,
  format_slug text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS linkedin_tokens (
  id                bigserial PRIMARY KEY,
  user_id           text NOT NULL,
  tenant_id         text NOT NULL DEFAULT 'default',
  access_token_enc  text NOT NULL,
  refresh_token_enc text,
  expires_at        timestamptz NOT NULL,
  linkedin_user_id  text,
  linkedin_name     text,
  linkedin_photo    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id               bigserial PRIMARY KEY,
  user_id          text NOT NULL,
  tenant_id        text NOT NULL DEFAULT 'default',
  post_id          bigint REFERENCES generated_posts(id),
  content          text NOT NULL,
  asset_type       text,
  asset_url        text,
  payload_hash     text,
  bull_job_id      text,
  scheduled_for    timestamptz NOT NULL,
  status           text DEFAULT 'pending',
  linkedin_post_id text,
  error_message    text,
  attempts         integer DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_user_status ON scheduled_posts (user_id, tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_scheduled_for ON scheduled_posts (scheduled_for, status);

CREATE TABLE IF NOT EXISTS scheduled_post_events (
  id                bigserial PRIMARY KEY,
  scheduled_post_id bigint NOT NULL REFERENCES scheduled_posts(id),
  user_id           text NOT NULL,
  tenant_id         text NOT NULL DEFAULT 'default',
  event_type        text NOT NULL,
  message           text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_post_events_post ON scheduled_post_events (scheduled_post_id, created_at);

CREATE TABLE IF NOT EXISTS media_files (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL,
  tenant_id   text NOT NULL DEFAULT 'default',
  filename    text NOT NULL,
  stored_name text NOT NULL,
  mime_type   text NOT NULL,
  file_size   bigint,
  width       integer,
  height      integer,
  format_tag  text,
  url         text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_files_user ON media_files (user_id, tenant_id);


-- Intelligence Vault: document ingestion, idea mining, and funnel intelligence
-- Adds vault_documents, vault_chunks, vault_ideas tables.
-- Adds funnel_type + vault_source_ref columns to generated_posts.

-- ── generated_posts additions ────────────────────────────────────────────────

ALTER TABLE generated_posts ADD COLUMN IF NOT EXISTS funnel_type      text;
ALTER TABLE generated_posts ADD COLUMN IF NOT EXISTS vault_source_ref text;

-- ── vault_documents ──────────────────────────────────────────────────────────
-- One row per uploaded file or URL. Tracks processing status and mining stats.

CREATE TABLE IF NOT EXISTS vault_documents (
  id            bigserial PRIMARY KEY,
  user_id       text NOT NULL,
  tenant_id     text NOT NULL DEFAULT 'default',
  filename      text NOT NULL,
  source_type   text NOT NULL,        -- 'pdf' | 'docx' | 'txt' | 'url'
  source_url    text,                 -- original URL for url-type documents
  storage_key   text,                 -- key in storage.js (null for url-type)
  status        text NOT NULL DEFAULT 'pending',
                                      -- 'pending' | 'indexing' | 'ready' | 'error'
  chunk_count   integer DEFAULT 0,
  ideas_mined   integer DEFAULT 0,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vault_documents_user
  ON vault_documents (user_id, tenant_id);

-- ── vault_chunks ─────────────────────────────────────────────────────────────
-- ~500-word chunks of each document with 10% overlap.
-- mined_at = null means the chunk has not been processed by the mining engine yet.

CREATE TABLE IF NOT EXISTS vault_chunks (
  id            bigserial PRIMARY KEY,
  document_id   bigint NOT NULL REFERENCES vault_documents(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  tenant_id     text NOT NULL DEFAULT 'default',
  chunk_index   integer NOT NULL,
  content       text NOT NULL,
  source_ref    text,                 -- human-readable location, e.g. "Page 4"
  mined_at      timestamptz           -- null = not yet mined
);

CREATE INDEX IF NOT EXISTS idx_vault_chunks_document
  ON vault_chunks (document_id);

CREATE INDEX IF NOT EXISTS idx_vault_chunks_unmined
  ON vault_chunks (user_id, mined_at)
  WHERE mined_at IS NULL;

-- ── vault_ideas ──────────────────────────────────────────────────────────────
-- Seed ideas extracted from vault chunks by the mining engine.
-- Each idea is classified by funnel type and hook archetype.

CREATE TABLE IF NOT EXISTS vault_ideas (
  id                bigserial PRIMARY KEY,
  user_id           text NOT NULL,
  tenant_id         text NOT NULL DEFAULT 'default',
  document_id       bigint REFERENCES vault_documents(id) ON DELETE CASCADE,
  chunk_id          bigint REFERENCES vault_chunks(id) ON DELETE SET NULL,
  seed_text         text NOT NULL,
  source_ref        text,             -- display string, e.g. "From: Q3 Strategy PDF · p.4"
  funnel_type       text,             -- 'reach' | 'trust' | 'convert'
  hook_archetype    text,             -- 'CONTRARIAN' | 'INSIGHT' | etc.
  status            text NOT NULL DEFAULT 'fresh',
                                      -- 'fresh' | 'saved' | 'discarded' | 'used'
  generated_post_id bigint REFERENCES generated_posts(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vault_ideas_user
  ON vault_ideas (user_id, tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_vault_ideas_document
  ON vault_ideas (document_id);

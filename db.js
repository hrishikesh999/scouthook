'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'scouthook.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema — all Phase 1 tables in one pass
// ---------------------------------------------------------------------------

db.exec(`
  -- Global platform settings (API keys, feature flags) — shared across tenants
  CREATE TABLE IF NOT EXISTS platform_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Per-tenant overrides (branding, limits, etc.)
  CREATE TABLE IF NOT EXISTS tenant_settings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id  TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, key)
  );

  -- Voice and audience profile (one row per user per tenant)
  CREATE TABLE IF NOT EXISTS user_profiles (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           TEXT NOT NULL,
    tenant_id         TEXT NOT NULL DEFAULT 'default',
    writing_samples   TEXT,
    contrarian_view   TEXT,
    audience_role     TEXT,
    audience_pain     TEXT,
    content_niche     TEXT,
    voice_fingerprint TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, tenant_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles (user_id, tenant_id);

  -- Post format configuration — never hardcoded, always from DB
  CREATE TABLE IF NOT EXISTS post_formats (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id           TEXT NOT NULL DEFAULT 'default',
    slug                TEXT NOT NULL,
    name                TEXT NOT NULL,
    description         TEXT,
    prompt_instructions TEXT,
    is_active           INTEGER DEFAULT 1,
    sort_order          INTEGER DEFAULT 0,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (slug, tenant_id)
  );

  -- Recipe library — 7 seeded in Phase 1, 5 more via DB insert in Phase 2
  CREATE TABLE IF NOT EXISTS recipes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id       TEXT NOT NULL DEFAULT 'default',
    slug            TEXT NOT NULL,
    name            TEXT NOT NULL,
    category        TEXT NOT NULL,
    description     TEXT,
    questions       TEXT NOT NULL,
    suggested_visual TEXT,
    suitable_formats TEXT,
    is_active       INTEGER DEFAULT 1,
    sort_order      INTEGER DEFAULT 0,
    UNIQUE (slug, tenant_id)
  );

  -- Generation runs (one per user session)
  CREATE TABLE IF NOT EXISTS generation_runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    tenant_id  TEXT NOT NULL DEFAULT 'default',
    path       TEXT NOT NULL,
    input_data TEXT,
    synthesis  TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_generation_runs_user_id ON generation_runs (user_id, tenant_id);

  -- Generated posts (3 per run)
  CREATE TABLE IF NOT EXISTS generated_posts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER NOT NULL REFERENCES generation_runs(id),
    user_id       TEXT NOT NULL,
    tenant_id     TEXT NOT NULL DEFAULT 'default',
    format_slug   TEXT NOT NULL,
    content       TEXT NOT NULL,
    quality_score INTEGER,
    quality_flags TEXT,
    passed_gate   INTEGER DEFAULT 0,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Copy events (feedback loop)
  CREATE TABLE IF NOT EXISTS copy_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    tenant_id   TEXT NOT NULL DEFAULT 'default',
    post_id     INTEGER REFERENCES generated_posts(id),
    run_id      INTEGER REFERENCES generation_runs(id),
    path        TEXT,
    format_slug TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- LinkedIn OAuth tokens (encrypted at rest)
  CREATE TABLE IF NOT EXISTS linkedin_tokens (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           TEXT NOT NULL,
    tenant_id         TEXT NOT NULL DEFAULT 'default',
    access_token_enc  TEXT NOT NULL,
    refresh_token_enc TEXT,
    expires_at        DATETIME NOT NULL,
    linkedin_user_id  TEXT,
    linkedin_name     TEXT,
    linkedin_photo    TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, tenant_id)
  );

  -- Scheduled posts
  CREATE TABLE IF NOT EXISTS scheduled_posts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          TEXT NOT NULL,
    tenant_id        TEXT NOT NULL DEFAULT 'default',
    post_id          INTEGER REFERENCES generated_posts(id),
    content          TEXT NOT NULL,
    scheduled_for    DATETIME NOT NULL,
    status           TEXT DEFAULT 'pending',
    linkedin_post_id TEXT,
    error_message    TEXT,
    attempts         INTEGER DEFAULT 0,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_posts_user_status ON scheduled_posts (user_id, tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_scheduled_posts_scheduled_for ON scheduled_posts (scheduled_for, status);
`);

// ---------------------------------------------------------------------------
// Platform settings helpers (global — shared across all tenants)
// ---------------------------------------------------------------------------

const stmtGetSetting = db.prepare('SELECT value FROM platform_settings WHERE key = ?');
const stmtSetSetting = db.prepare(
  'INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
);
const stmtGetAllSettings = db.prepare('SELECT key, value FROM platform_settings ORDER BY key');

function getSetting(key) {
  const row = stmtGetSetting.get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  stmtSetSetting.run(key, value);
}

function getAllSettings() {
  return stmtGetAllSettings.all();
}

// ---------------------------------------------------------------------------
// Tenant settings helpers (per-tenant overrides)
// ---------------------------------------------------------------------------

const stmtGetTenantSetting = db.prepare(
  'SELECT value FROM tenant_settings WHERE tenant_id = ? AND key = ?'
);
const stmtSetTenantSetting = db.prepare(
  'INSERT INTO tenant_settings (tenant_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
);

function getTenantSetting(tenantId, key) {
  const row = stmtGetTenantSetting.get(tenantId, key);
  return row ? row.value : null;
}

function setTenantSetting(tenantId, key, value) {
  stmtSetTenantSetting.run(tenantId, key, value);
}

// ---------------------------------------------------------------------------
// Migrations — add columns that didn't exist in the initial schema
// SQLite throws "duplicate column name" if the column already exists; ignore it.
// ---------------------------------------------------------------------------
for (const sql of [
  "ALTER TABLE user_profiles ADD COLUMN brand_bg     TEXT DEFAULT '#0F1A3C'",
  "ALTER TABLE user_profiles ADD COLUMN brand_accent TEXT DEFAULT '#0D7A5F'",
  "ALTER TABLE user_profiles ADD COLUMN brand_text   TEXT DEFAULT '#F0F4FF'",
  "ALTER TABLE user_profiles ADD COLUMN brand_name   TEXT",
  "ALTER TABLE user_profiles ADD COLUMN brand_logo   TEXT",
  "ALTER TABLE generated_posts ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'",
  "ALTER TABLE generated_posts ADD COLUMN published_at DATETIME",
  "ALTER TABLE generated_posts ADD COLUMN idea_input      TEXT",
  "ALTER TABLE generated_posts ADD COLUMN linkedin_post_id TEXT",
  "ALTER TABLE generated_posts ADD COLUMN likes           INTEGER DEFAULT 0",
  "ALTER TABLE generated_posts ADD COLUMN comments        INTEGER DEFAULT 0",
  "ALTER TABLE generated_posts ADD COLUMN reactions       INTEGER DEFAULT 0",
  "ALTER TABLE generated_posts ADD COLUMN last_synced_at  DATETIME",
]) {
  try { db.exec(sql); } catch (_) { /* column already exists */ }
}

module.exports = {
  db,
  getSetting,
  setSetting,
  getAllSettings,
  getTenantSetting,
  setTenantSetting,
};

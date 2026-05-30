-- Migration 034: Example library
-- Stores hand-curated LinkedIn posts used as quality calibration examples during generation.
-- Two approved posts are selected per generation call and injected into the Stage 2 Sonnet prompt.
-- Posts are never shown to users — they are invisible calibration anchors only.

CREATE TABLE IF NOT EXISTS example_library (
  id             SERIAL PRIMARY KEY,
  post_text      TEXT        NOT NULL,
  post_type      VARCHAR(20),            -- reach | trust | convert | lead_magnet | NULL (matches any)
  hook_archetype VARCHAR(30),            -- CONFESSION | BEFORE_AFTER | INSIGHT | DIRECT_ADDRESS | NUMBER | MYTH_BUST | CURIOSITY_GAP | REFRAME | NULL
  niche          TEXT,                   -- free-text curation label (e.g. "Management consulting") — never used for matching
  source_url     TEXT        UNIQUE,     -- LinkedIn URL for provenance reference; never shown to users
  approved       BOOLEAN     NOT NULL DEFAULT false,
  times_used     INTEGER     NOT NULL DEFAULT 0,
  retired        BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at    TIMESTAMPTZ
);

-- Index used by selectExamples() waterfall: exact match, then post_type only, then any approved
CREATE INDEX IF NOT EXISTS idx_example_library_selection
  ON example_library (post_type, hook_archetype)
  WHERE approved = true AND retired = false;

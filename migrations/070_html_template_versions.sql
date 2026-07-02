-- Version history for admin HTML templates. Every save snapshots the stored
-- state; revert restores any snapshot. Converts every destructive bug in the
-- template pipeline (AI refine gone wrong, bad raw-HTML edit, accidental save)
-- from permanent data loss into a one-click revert.

CREATE TABLE IF NOT EXISTS html_template_versions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   UUID        NOT NULL REFERENCES html_templates(id) ON DELETE CASCADE,
  label         TEXT        NOT NULL DEFAULT 'save',   -- 'create' | 'save' | 'pre-versioning baseline' | 'pre-revert' | 'revert'
  html          TEXT        NOT NULL,
  slot_manifest JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_html_template_versions_template
  ON html_template_versions (template_id, created_at DESC);

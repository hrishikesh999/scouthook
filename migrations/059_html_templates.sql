CREATE TABLE IF NOT EXISTS html_templates (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  description      TEXT,
  html_r2_key      TEXT        NOT NULL,    -- R2 object key: templates/{id}.html
  thumbnail_r2_key TEXT,                    -- R2 object key: thumbnails/{id}.png
  slot_manifest    JSONB       NOT NULL DEFAULT '{}',
  category         TEXT,
  active           BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order       INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS html_templates_active_order ON html_templates (active, sort_order);

-- Carousel Studio (Level 3 editor) foundations:
--   * carousel_drafts — one editable deck document per post (autosaved Studio state)
--   * carousel_packs.aspect_ratio — 'square' (1080×1080) | 'portrait' (1080×1350),
--     derived from the pack's template dimensions at creation time
--   * html_templates.variant_group — templates sharing a group are interchangeable
--     layout variants for the same role/slot set within a pack

CREATE TABLE IF NOT EXISTS carousel_drafts (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    BIGINT      NOT NULL REFERENCES generated_posts(id) ON DELETE CASCADE,
  user_id    TEXT        NOT NULL,
  tenant_id  TEXT        NOT NULL DEFAULT 'default',
  deck       JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (post_id)
);

CREATE INDEX IF NOT EXISTS carousel_drafts_tenant ON carousel_drafts (tenant_id, user_id);

ALTER TABLE carousel_packs
  ADD COLUMN IF NOT EXISTS aspect_ratio TEXT NOT NULL DEFAULT 'square'
  CHECK (aspect_ratio IN ('square', 'portrait'));

ALTER TABLE html_templates
  ADD COLUMN IF NOT EXISTS variant_group UUID;

CREATE INDEX IF NOT EXISTS html_templates_variant_group
  ON html_templates (variant_group) WHERE variant_group IS NOT NULL;

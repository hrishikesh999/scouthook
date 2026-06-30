-- Carousel packs: groups of HTML templates (title + content + closing) that
-- render multi-slide carousels via Puppeteer.

CREATE TABLE IF NOT EXISTS carousel_packs (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT        NOT NULL,
  description        TEXT,
  thumbnail_r2_key   TEXT,
  category           TEXT,
  variable_map       JSONB       NOT NULL DEFAULT '{}',
  min_content_slides INTEGER     NOT NULL DEFAULT 3,
  max_content_slides INTEGER     NOT NULL DEFAULT 8,
  active             BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order         INTEGER     NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS carousel_pack_slides (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id       UUID    NOT NULL REFERENCES carousel_packs(id) ON DELETE CASCADE,
  template_id   UUID    NOT NULL REFERENCES html_templates(id) ON DELETE RESTRICT,
  role          TEXT    NOT NULL CHECK (role IN ('title', 'content', 'closing')),
  slide_order   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (pack_id, role, slide_order)
);

CREATE INDEX IF NOT EXISTS carousel_packs_active_order ON carousel_packs (active, sort_order);
CREATE INDEX IF NOT EXISTS carousel_pack_slides_pack   ON carousel_pack_slides (pack_id, slide_order);

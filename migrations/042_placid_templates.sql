-- Placid template library per workspace
CREATE TABLE placid_templates (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT        NOT NULL,
  name              TEXT        NOT NULL,
  template_uuid     TEXT        NOT NULL,
  layer_headline    TEXT        NOT NULL DEFAULT 'headline',
  layer_subtext     TEXT        NOT NULL DEFAULT 'subtext',
  preview_image_url TEXT,
  sort_order        INTEGER     NOT NULL DEFAULT 0,
  is_default        BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX placid_templates_tenant_order ON placid_templates (tenant_id, sort_order);

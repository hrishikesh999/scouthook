-- Authentic Client Engine — post-level signals.
--
-- Phase 2 (Make It Yours): record how much the author personalised a generated
-- post. `human_edit_chars` is a rough char-delta between the generated draft and
-- the published text; `miy_spans_edited` counts how many suggested spans they
-- rewrote. Phase 4 correlates these with engagement ("posts you touched perform
-- better") and the admin funnel reads them.
--
-- Phase 6 (variance): `hook_shape` stamps the first-line archetype at generation
-- time (question | number_lead | contrast | confession | statement | quote |
-- second_person | scene) so the engine can avoid repeating a shape across an
-- author's recent posts.

ALTER TABLE generated_posts
  ADD COLUMN IF NOT EXISTS human_edit_chars integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS miy_spans_edited integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hook_shape       text;

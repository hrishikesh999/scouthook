-- Carousel archetype roles: widen carousel_pack_slides.role beyond the
-- title/content/closing triad so packs can offer typed slide archetypes
-- (big-stat, list, quote, comparison, cta) for visual rhythm. Title stays the
-- cover and closing stays the payoff; the new roles are all "content-class"
-- (they sit in the swipeable middle and are interchangeable with 'content').

ALTER TABLE carousel_pack_slides DROP CONSTRAINT IF EXISTS carousel_pack_slides_role_check;

ALTER TABLE carousel_pack_slides
  ADD CONSTRAINT carousel_pack_slides_role_check
  CHECK (role IN ('title', 'content', 'closing', 'stat', 'list', 'quote', 'comparison', 'cta'));

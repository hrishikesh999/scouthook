-- Migration 033: Archetype vocabulary refactor
-- Replaces CONTRARIAN → MYTH_BUST, PATTERN_INTERRUPT → CURIOSITY_GAP, STAKES → BEFORE_AFTER
-- across all archetype-bearing columns and JSON preference maps.

-- Remap archetype_used on generated_posts
UPDATE generated_posts SET archetype_used = 'MYTH_BUST'     WHERE archetype_used = 'CONTRARIAN';
UPDATE generated_posts SET archetype_used = 'CURIOSITY_GAP' WHERE archetype_used = 'PATTERN_INTERRUPT';
UPDATE generated_posts SET archetype_used = 'BEFORE_AFTER'  WHERE archetype_used = 'STAKES';

-- Remap hook_b_archetype on generated_posts
UPDATE generated_posts SET hook_b_archetype = 'MYTH_BUST'     WHERE hook_b_archetype = 'CONTRARIAN';
UPDATE generated_posts SET hook_b_archetype = 'CURIOSITY_GAP' WHERE hook_b_archetype = 'PATTERN_INTERRUPT';
UPDATE generated_posts SET hook_b_archetype = 'BEFORE_AFTER'  WHERE hook_b_archetype = 'STAKES';

-- Remap user_archetype_preference JSON keys on user_profiles
-- jsonb_object_agg renames keys; STAKES counts merge into BEFORE_AFTER (last-write wins for small overlap)
UPDATE user_profiles
SET user_archetype_preference = (
  SELECT jsonb_object_agg(
    CASE key
      WHEN 'CONTRARIAN'        THEN 'MYTH_BUST'
      WHEN 'PATTERN_INTERRUPT' THEN 'CURIOSITY_GAP'
      WHEN 'STAKES'            THEN 'BEFORE_AFTER'
      ELSE key
    END,
    value
  )
  FROM jsonb_each(user_archetype_preference::jsonb)
)
WHERE user_archetype_preference IS NOT NULL
  AND user_archetype_preference <> '';

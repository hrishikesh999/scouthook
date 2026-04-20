-- CTA alternative closing lines generated alongside each post.
-- Allows the user to swap in a different closing CTA without regenerating the full post.
-- Stored as a JSON array of up to 2 strings, matching the hookB swap-chip pattern.
ALTER TABLE generated_posts ADD COLUMN IF NOT EXISTS cta_alternatives text;

-- Alternative hook line generated alongside each post.
-- Allows the user to swap in a different first line without regenerating the full post.
ALTER TABLE generated_posts ADD COLUMN IF NOT EXISTS hook_b text;

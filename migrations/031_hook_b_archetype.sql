-- Migration 031: Store Hook B archetype label alongside hook_b text.
-- Enables the editor to show what structural type Hook B uses.
ALTER TABLE generated_posts ADD COLUMN IF NOT EXISTS hook_b_archetype TEXT;

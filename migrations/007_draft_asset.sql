-- Persist attached visual asset (quote card / branded quote / carousel) with draft posts
ALTER TABLE generated_posts ADD COLUMN IF NOT EXISTS asset_url          text;
ALTER TABLE generated_posts ADD COLUMN IF NOT EXISTS asset_preview_url  text;
ALTER TABLE generated_posts ADD COLUMN IF NOT EXISTS asset_slide_count  integer;

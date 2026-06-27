-- Add thumbnail_url to media_files for faster grid loading.
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS thumbnail_url text;

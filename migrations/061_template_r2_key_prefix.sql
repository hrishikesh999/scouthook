-- Prefix existing template/thumbnail R2 keys with 'global/' to match new storage hierarchy.
-- Run AFTER copying files in R2:
--   rclone copy r2:scouthook-prod/templates r2:scouthook-prod/global/templates --progress
--   rclone copy r2:scouthook-prod/thumbnails r2:scouthook-prod/global/thumbnails --progress
UPDATE html_templates
SET
  html_r2_key      = 'global/' || html_r2_key,
  thumbnail_r2_key = CASE WHEN thumbnail_r2_key IS NOT NULL THEN 'global/' || thumbnail_r2_key ELSE NULL END
WHERE html_r2_key NOT LIKE 'global/%';

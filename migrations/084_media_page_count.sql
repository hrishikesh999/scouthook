-- Store PDF page count so the editor preview can show "Document · N pages"
-- for uploaded PDFs, matching the existing carousel_pack slide-count badge.
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS page_count integer;

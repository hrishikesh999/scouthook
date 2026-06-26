-- Flag carousel slide templates so they don't appear in the standalone gallery.
ALTER TABLE html_templates ADD COLUMN is_carousel_slide BOOLEAN NOT NULL DEFAULT FALSE;

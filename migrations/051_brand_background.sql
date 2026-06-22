-- Migration 051: rich background options for brand settings
-- Supports solid, gradient, pattern, and image backgrounds.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS brand_bg_type     TEXT DEFAULT 'solid';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS brand_bg_gradient TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS brand_bg_pattern  TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS brand_bg_image    TEXT;

-- Typography and extended color fields for workspace brand settings
ALTER TABLE workspaces ADD COLUMN brand_font_heading    TEXT;
ALTER TABLE workspaces ADD COLUMN brand_font_body       TEXT;
ALTER TABLE workspaces ADD COLUMN brand_secondary_bg    TEXT;
ALTER TABLE workspaces ADD COLUMN brand_secondary_text  TEXT;

-- Brand layer mappings per Placid template
-- Format: [{ layer_name, property ('color'|'background_color'|'font_family'|'image_url'), brand_source }]
ALTER TABLE placid_templates ADD COLUMN brand_layers TEXT NOT NULL DEFAULT '[]';

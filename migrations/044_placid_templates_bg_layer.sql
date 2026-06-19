-- Add optional background image layer name to Placid templates
ALTER TABLE placid_templates ADD COLUMN IF NOT EXISTS layer_background TEXT;

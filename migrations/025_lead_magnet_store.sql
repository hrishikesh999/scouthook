ALTER TABLE generated_posts ADD COLUMN IF NOT EXISTS lead_magnet_template VARCHAR(30);
ALTER TABLE generated_posts ADD COLUMN IF NOT EXISTS lead_magnet_inputs TEXT;

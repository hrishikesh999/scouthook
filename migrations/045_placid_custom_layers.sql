-- Add custom_layers column to store extra Placid template fields beyond headline/subtext/background.
-- Format: JSON array of { layer_name, label, type ('text'|'image'), max_chars? }
ALTER TABLE placid_templates ADD COLUMN custom_layers TEXT NOT NULL DEFAULT '[]';

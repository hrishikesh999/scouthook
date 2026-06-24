-- visual_generation_log.visual_type has no CHECK constraint (plain text column).
-- This migration documents that 'template' is now a valid visual_type value
-- alongside: quote_card, carousel, branded_quote, ai_image, infographic,
--             metrics_card, client_win, framework.
-- No schema change required.

COMMENT ON COLUMN visual_generation_log.visual_type IS
  'quote_card | carousel | branded_quote | ai_image | infographic | metrics_card | client_win | framework | template';

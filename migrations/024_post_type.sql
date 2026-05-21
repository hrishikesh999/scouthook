-- Sprint 3: post_type for content mix tracking, quality_verdict for actionable editor feedback,
-- hook_preview on vault_ideas for eager hook generation at mining time.
ALTER TABLE generated_posts ADD COLUMN IF NOT EXISTS post_type VARCHAR(15);
ALTER TABLE generated_posts ADD COLUMN IF NOT EXISTS quality_verdict TEXT;
ALTER TABLE vault_ideas ADD COLUMN IF NOT EXISTS hook_preview TEXT;

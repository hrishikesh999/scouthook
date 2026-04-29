-- Ghostwriter: personalized AI prompt built from vault documents + profile
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS business_positioning VARCHAR(500),
  ADD COLUMN IF NOT EXISTS ghostwriter_prompt TEXT,
  ADD COLUMN IF NOT EXISTS ghostwriter_prompt_built_at TIMESTAMPTZ;

-- Group the 5 posts from a weekly batch together
ALTER TABLE generated_posts
  ADD COLUMN IF NOT EXISTS batch_id UUID;

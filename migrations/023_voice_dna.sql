-- migrations/023_voice_dna.sql
-- Sprint 2: Voice DNA Architecture
-- Adds new columns only. All IF NOT EXISTS — safe to re-run.
-- Does NOT touch: user_role, onboarding_complete, website_url, voice_fingerprint,
--                 writing_samples, contrarian_view, audience_role, audience_pain,
--                 content_niche, business_positioning (all exist, all in active use).

-- Tag onboarding-generated posts so we can track first-post conversion separately
ALTER TABLE generated_posts
  ADD COLUMN IF NOT EXISTS source TEXT;
  -- Values: 'onboarding' | null (all existing posts)

-- Onboarding capture fields
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS website_summary TEXT,
  -- AI-extracted narrative from website crawl (2-4 sentences).
  -- Distinct from business_positioning (user-entered). Both coexist.
  ADD COLUMN IF NOT EXISTS website_extracted_at TIMESTAMPTZ,

  ADD COLUMN IF NOT EXISTS onboarding_q1 TEXT,
  -- "What do most people in your field get wrong — and what do you believe instead?"
  -- Also written to contrarian_view for backward compat with existing prompt builders.
  ADD COLUMN IF NOT EXISTS onboarding_q2 TEXT,
  -- "If a close friend asked what you actually do all day, what would you tell them?"
  -- Primary voice signal — casual, unguarded language.
  ADD COLUMN IF NOT EXISTS onboarding_q3 TEXT,
  -- "Describe a specific result your work produced. Numbers if you have them."
  ADD COLUMN IF NOT EXISTS onboarding_q_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ,

  -- Voice DNA fields
  ADD COLUMN IF NOT EXISTS authority_statements TEXT,
  -- JSON array, up to 10. Auto-extracted verbatim from Q3. User-editable in wizard.
  -- Never invented. Verbatim from user's own content only.
  ADD COLUMN IF NOT EXISTS cta_library TEXT,
  -- JSON array, up to 10. User-entered in Voice Profile Wizard. Not auto-extracted.
  ADD COLUMN IF NOT EXISTS banned_patterns TEXT,
  -- JSON array. Universal AI smell list + user-specific additions from Q&A.
  -- Injected as ABSOLUTE RULES in system prompt via buildVoiceDNABlock().
  ADD COLUMN IF NOT EXISTS content_principles TEXT,
  -- JSON array, up to 20. User-entered in wizard (advanced/optional, collapsed by default).
  ADD COLUMN IF NOT EXISTS content_themes TEXT,
  -- JSON array of confirmed content themes (Voice Profile Wizard Stage 1).
  -- Distinct from content_niche (plain string used by existing prompt builders — not changed).
  -- Injected into buildVoiceDNABlock() only.
  ADD COLUMN IF NOT EXISTS voice_refinements TEXT,
  -- JSON array, capped at 20 entries. Auto-captured from edit deltas (>30% edit ratio).
  -- Internal signal — not user-editable.
  ADD COLUMN IF NOT EXISTS voice_extraction_source VARCHAR(20),
  -- 'none' | 'qa_answers' | 'writing_samples' | 'linkedin_posts' | 'combined'
  ADD COLUMN IF NOT EXISTS voice_extraction_quality VARCHAR(10),
  -- 'none' | 'baseline' | 'partial' | 'full'
  ADD COLUMN IF NOT EXISTS voice_profile_completion_pct INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS voice_profile_completed_at TIMESTAMPTZ;

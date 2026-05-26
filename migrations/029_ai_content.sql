-- Migration 029: Phase 5 — Feedback Loop
-- Adds ai_content to preserve the original AI-generated output for before/after comparison.
-- The PATCH /api/posts/:id endpoint only updates `content`, never ai_content,
-- so this column always holds the unedited AI version for voice refinement analysis.

ALTER TABLE generated_posts ADD COLUMN IF NOT EXISTS ai_content TEXT;

-- Migration 027: Phase 2 — Voice Signal from Real Writing
-- Adds website_articles_text to store full blog post text extracted from the user's website.
-- This provides richer voice signal than the homepage summary alone.

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS website_articles_text TEXT;
-- Full text of up to 3 blog/article pages from the user's website.
-- Extracted at website-submit time during onboarding.
-- Fed into extractVoiceDNAFromQA() alongside Q&A answers for richer voice extraction.

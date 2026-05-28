ALTER TABLE feedback
  ADD COLUMN IF NOT EXISTS category TEXT
  CHECK (category IN ('feature_request', 'bug_report', 'improvement'));

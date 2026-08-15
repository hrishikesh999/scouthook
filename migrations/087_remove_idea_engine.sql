-- Remove the Ideas / Idea Engine feature (dashboard "Today's 3", streak,
-- Ideas tab, daily idea emails, and the in-composer "fresh ideas" panel).
-- Vault insights/angles and vault_ideas.source = 'mined' rows are untouched.

-- generated_posts.idea_card_id was the origin stamp for posts started from a
-- served idea card — the feature (and idea_cards) is gone, so the FK goes too.
ALTER TABLE generated_posts
  DROP COLUMN IF EXISTS idea_card_id;

DROP TABLE IF EXISTS idea_cards;

-- Consistency streak + idea-email preferences (Idea Engine Phase 2).
ALTER TABLE user_profiles
  DROP COLUMN IF EXISTS streak_count,
  DROP COLUMN IF EXISTS streak_last_date,
  DROP COLUMN IF EXISTS idea_email_cadence,
  DROP COLUMN IF EXISTS idea_email_timezone;

-- vault_ideas.source is shared with document mining ('mined') — keep the
-- column and any existing 'idea_engine' / 'daily_question' rows as history;
-- the app no longer writes those source values.

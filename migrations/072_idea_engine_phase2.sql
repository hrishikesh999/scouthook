-- Idea Engine Phase 2 — retention layer (sprint-idea-engine-phase2.md, spec R6-R9).
--
-- Streak ("Consistency"): consecutive days with at least one pipeline action
-- (save card / answer question / generate post). Lazy daily reset: streak_last_date
-- older than yesterday means the streak is broken — no cron needed, the read path
-- (services/streak.js) reports 0. Midnight UTC boundary for all users (open
-- question resolved: daily, not rolling — keeps cohorts comparable).
--
-- Idea email cadence: 'daily' | '3x' | 'weekly' | 'off'. NULL means the user
-- never chose — treated as 'weekly' (day-1 default, lowest unsubscribe risk).
-- Timezone is an IANA name captured from the browser on first settings save;
-- NULL falls back to America/New_York in the email cron.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS streak_count        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS streak_last_date    date,
  ADD COLUMN IF NOT EXISTS idea_email_cadence  text,
  ADD COLUMN IF NOT EXISTS idea_email_timezone text;

-- Queue lookups: "saved cards, oldest first" on the Ideas tab.
-- (idea_cards.status gains an 'archived' value — soft-delete out of the queue;
-- status is unconstrained text so no schema change needed for the value itself.)
CREATE INDEX IF NOT EXISTS idx_idea_cards_tenant_saved
  ON idea_cards (tenant_id, updated_at)
  WHERE status = 'saved';

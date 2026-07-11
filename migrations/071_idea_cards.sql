-- Idea Engine Phase 1 (see idea-engine-spec-2026.md, R1/R2/R5).
-- idea_cards: the daily served "Today's 3" cards. One row per card per user per day.
-- Cards are generated on first dashboard load of the day and cached here.
-- generated_posts.idea_card_id: origin stamp — a non-null value means the post
-- started from a served idea (the north-star metric numerator).

CREATE TABLE IF NOT EXISTS idea_cards (
  id               bigserial PRIMARY KEY,
  user_id          text NOT NULL,
  tenant_id        text NOT NULL DEFAULT 'default',
  hook             text NOT NULL,              -- written first line shown on the card
  title            text,                       -- 3-7 word topic title
  textarea_input   text,                       -- first-person raw input to prefill the generator
  post_type        text,                       -- 'reach' | 'trust' | 'convert' | 'lead_magnet'
  tier             smallint NOT NULL,          -- 3 vault · 2 behavioral · 1 profile · 0 evergreen
  provenance_ref   text,                       -- machine ref: 'vault_idea:123' | 'post:456' | 'pillar:...' | 'evergreen:slug'
  provenance_label text,                       -- display: "From your Q3 strategy doc"
  is_question      boolean NOT NULL DEFAULT false,  -- daily-question card variant (P1)
  status           text NOT NULL DEFAULT 'served',
                                               -- 'served' | 'saved' | 'dismissed' | 'generated' | 'expired'
  served_on        date NOT NULL DEFAULT CURRENT_DATE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_idea_cards_tenant_day
  ON idea_cards (tenant_id, served_on DESC);

-- Dedup lookups: "never re-serve a dismissed/served angle"
CREATE INDEX IF NOT EXISTS idx_idea_cards_tenant_status
  ON idea_cards (tenant_id, status);

ALTER TABLE generated_posts
  ADD COLUMN IF NOT EXISTS idea_card_id bigint REFERENCES idea_cards(id) ON DELETE SET NULL;

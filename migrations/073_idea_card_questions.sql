-- Idea Engine "Option B" — two pre-minted extraction questions per idea card.
--
-- When the daily Sonnet call writes a card it also writes exactly two questions
-- the consultant answers before drafting (Q1 = the real moment behind the idea,
-- Q2 = concrete proof/number). Clicking "Write this" enters a deterministic
-- 2-question flow instead of pasting the AI-drafted textarea_input in as if the
-- user typed it.
--
-- Shape: { "v": 1, "source": "llm" | "static",
--          "items": [ {"key":"moment","q":"…","help":"…"},
--                     {"key":"proof","q":"…","help":"…"} ] }
--
-- NULL means: question cards (is_question = true, which keep their answer flow)
-- and any card served before this migration — the client falls back to the old
-- textarea_input prefill for those.

ALTER TABLE idea_cards ADD COLUMN IF NOT EXISTS questions jsonb;

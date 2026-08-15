-- Instrumentation for the first-post flow (/start).
--
-- Both columns record things the system already knows and currently discards,
-- which is why the funnel could not be read: 2,838 idea cards were served before
-- anyone could see that only 51 were ever tapped.
--
-- retention_score: services/retention.js scores every organize generation and the
-- result reaches the browser, but nothing persists it. Without the column there
-- is no way to answer "did fidelity move?" after a prompt or flow change, and no
-- way to show the author "84% your words" from stored data rather than a live
-- response. numeric(4,3) holds the 0.000–1.000 range the scorer emits.
--
-- starter_template: which elicitation template the author tapped on /start
-- (see sprint-first-post-flow.md). Nullable by design — posts made anywhere else
-- in the app have no template, and pre-existing rows never will.
ALTER TABLE generated_posts
  ADD COLUMN IF NOT EXISTS retention_score  numeric(4,3),
  ADD COLUMN IF NOT EXISTS starter_template text;

-- Partial: only /start posts carry a template, so the index stays small while
-- still serving the funnel query (template → generated → published).
CREATE INDEX IF NOT EXISTS idx_generated_posts_starter_template
  ON generated_posts (starter_template, created_at DESC)
  WHERE starter_template IS NOT NULL;

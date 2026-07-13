-- Vault knowledge store (idea-engine consolidation).
--
-- Documents are now CLASSIFIED into reusable insights instead of mined into
-- discrete post ideas. The daily idea generator (services/ideaEngine.js) reads
-- these insights as grounding material — one insight anchors one card slot,
-- mirroring the sequel-seed pattern — so vault content flows through the same
-- audience-aware / funnel-aware generation as everything else, rather than a
-- separate one-shot mining prompt.
--
-- vault_ideas is NOT dropped: its auto_extracted (typed input) and
-- daily_question (answered prompts) rows are single fragments in the user's own
-- words and still feed the T3 supply ladder. Only document mining stops
-- producing vault_ideas rows; legacy mined rows drain naturally.

CREATE TABLE IF NOT EXISTS vault_insights (
  id           bigserial PRIMARY KEY,
  user_id      text NOT NULL,
  tenant_id    text NOT NULL DEFAULT 'default',
  document_id  bigint NOT NULL REFERENCES vault_documents(id) ON DELETE CASCADE,
  category     text NOT NULL,          -- 'quote' | 'lesson' | 'advice' | 'mindset_shift' | 'key_insight' | 'strategy'
  content      text NOT NULL,          -- the insight itself; mindset_shift stored as "From: X → To: Y"
  source_ref   text,                   -- display label of the source chunk, e.g. "p.4" or "chunk 3"
  used_count   integer NOT NULL DEFAULT 0,   -- times fed to generation (rotation signal)
  last_used_at timestamptz,            -- NULL = never used → picked first
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Retrieval: "least-recently-used insights for this workspace", round-robin by category.
CREATE INDEX IF NOT EXISTS idx_vault_insights_tenant_rotation
  ON vault_insights (tenant_id, last_used_at ASC NULLS FIRST);

-- Per-document listing for the vault UI overlay.
CREATE INDEX IF NOT EXISTS idx_vault_insights_document
  ON vault_insights (document_id);

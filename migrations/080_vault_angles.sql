-- 080_vault_angles.sql
--
-- Vault angles: a claim plus the material that serves it.
--
-- Why: one mined insight makes a shallow post — a single assertion with nothing
-- proving it and nothing to argue against. But the missing pieces are usually
-- already in the same document a few insights away: the claim in one place, the
-- number that proves it in another, the belief it contradicts in a third. The
-- insights panel listed them separately, so nobody joined them up.
--
-- An angle is that join, made explicit and ROLE-ASSIGNED. Not "these four
-- insights go together" — combining by coverage produces "4 lessons from my case
-- study", which is the forgettable format we are avoiding. Instead: one insight
-- is the spine (the claim), the others are tension / proof / mechanism /
-- consequence in service of it. See services/vaultBrief.js for why the roles have
-- to reach the model as labels, and sprint-vault-angles.md for the whole design.
--
-- roles is jsonb rather than a join table on purpose. A document yields ~3 angles
-- over ~30 insights, so a join table is normalisation nothing will ever query.
-- insight_ids duplicates the same ids as a flat array purely to answer the one
-- reverse question we do need — "which angles use this insight" — cheaply, for
-- the per-insight click path (Phase 4).
--
-- Scoped per document, never across documents: splicing a number from one
-- engagement onto a claim from another would imply a relationship that may not
-- exist. That is a factual-integrity failure, not a quality one.

CREATE TABLE IF NOT EXISTS vault_angles (
  id           bigserial PRIMARY KEY,
  user_id      text NOT NULL,
  tenant_id    text NOT NULL DEFAULT 'default',
  document_id  bigint NOT NULL REFERENCES vault_documents(id) ON DELETE CASCADE,
  title        text NOT NULL,          -- a CLAIM someone could disagree with, not a topic
  roles        jsonb NOT NULL,         -- { spine: <insight_id>, tension: <id>|null, proof: ..., mechanism: ..., consequence: ... }
  insight_ids  bigint[] NOT NULL,      -- flattened roles, for reverse lookup
  used_count   integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Panel listing: "the angles for this document".
CREATE INDEX IF NOT EXISTS idx_vault_angles_document
  ON vault_angles (document_id);

-- Reverse lookup: "which angles contain this insight" (Phase 4 per-insight path).
CREATE INDEX IF NOT EXISTS idx_vault_angles_insights
  ON vault_angles USING gin (insight_ids);

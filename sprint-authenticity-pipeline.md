# Sprint — Authenticity Pipeline Consolidation

Written 2026-07-13. Diagnosis: LinkedIn post quality is AI-sounding because the 10 dedicated
post-type services (`services/*Path.js`) are prompt clones ("Justin Welsh" persona, mandated
hashtags, rigid EXACT structures) that bypass every authenticity control built in `ideaPath.js`,
and the Idea Engine fabricates first-person anecdotes (`textarea_input`) that downstream
generation treats as real. LinkedIn's 2026 360Brew classifier penalises exactly this output
(~30% reach / ~55% engagement loss for "low-effort AI"): it measures lexical diversity,
sentence-rhythm variance, and templated frameworks — not banned phrases.

**Strategy:** consolidate the implementation, keep the menu. One generation engine + a recipe
registry; the 10 post types survive as user-facing structure recipes. Provenance contract so
specifics only come from author-real material. Quality gate v2 measures what 360Brew measures.

---

## Phase 0 — Safety net (~1h)

No behaviour change. Do first.

1. **Prompt snapshot fixtures.** Small script/test that assembles the current system prompt for
   each of the 10 services against a fixture profile and writes them to `tests/fixtures/prompts/`.
   Used to diff intended vs accidental changes during migration.
2. **Contract test.** For each service module: returns `{ post: string, synthesis: object }`.
   This contract must survive every phase (routes/DB depend on it).
3. Delete stale `tests/hookSelector.test.js` (`services/hookSelector.js` was removed in the
   pipeline cleanup; see linkedin-algorithm-features.md "Dead code removal").

## Phase 1 — Shared authenticity core (~half day)

New module `services/generationCore.js`:

- `buildAuthenticityCore()` — one string assembled from the pieces that today live only in
  `ideaPath.js`: `AI_TELLS_PROHIBITION` (postSanitiser.js), `SPECIFICITY_MANDATE`, `SELF_CHECK`,
  DEPTH instruction, HOOK rules (≤15 words, no announcement openers), ABOVE-THE-FOLD rules,
  POINT OF VIEW block, LinkedIn formatting (one sentence per line, breathing room). Exports the
  pieces individually too so ideaPath.js can consume the same source (no drift).
- `buildSharedAuthorContext(profile)` — merges the 10 copy-pasted `buildAuthorContext()`
  implementations (identical; ~50 lines × 10) plus `buildPhraseLibraryBlock` from ideaPath.js
  (the 10 services don't have the phrase library today). Voice DNA, brand voice, audience,
  authority proof, phrases.
- **Framework/save carve-out** inside the core: numbered enumeration is allowed when the post's
  purpose is a framework/checklist; the "no three parallel points" rule applies to commentary,
  not to reference lists.
- `ideaPath.js` switches to importing from generationCore (delete its local copies).

Subsumes roadmap item 02 (depth score → 10 services) in linkedin-algorithm-features.md.

## Phase 2 — Recipe registry + unified engine (~1 day)

1. **`services/postRecipes.js`** — one entry per post type:
   ```js
   {
     slug: 'story',                    // matches routes' post_type value
     sseLabel: 'Crafting your story...',
     structureGuide: '...',            // distilled from that service's V2_PROMPT_CORE,
                                       // demoted from "EXACT" to "cover these beats in the
                                       // order the material supports; break beat symmetry"
     defaultGoal: 'trust',             // funnel goal for CTA/length defaults (Phase 6 splits axis)
     acceptsCtaIntent: true,           // authority, bts, lessons, story, results have ctaIntent
     lengthProfile: 'medium',
   }
   ```
   NO persona header. NO hashtag mandate (see rollout note). The structureGuide is the ONLY
   type-specific prompt text.
2. **`services/postEngine.js`** — evolved from `runSinglePostGeneration` (ideaPath.js:281).
   System prompt = authenticityCore + sharedAuthorContext + publishedExamples + recipe
   structureGuide + goal block + CTA instruction. `temperature: 0.8` (services currently run
   SDK default 1.0). `cache_control` on the stable prefix. `sanitiseAiTells()` on output.
   Returns `{ post, synthesis }`.
3. **Migrate service-by-service** — each `*Path.js` becomes a thin wrapper
   (`generateStoryPost(rawIdea, profile, opts)` → `postEngine.generate('story', ...)`) so module
   exports and routes stay untouched per step. One commit per service. Order (blast radius,
   lowest first): announcement → bts → contrarian → framework → lead_gen → story →
   lessons_learned → authority (trust) → pis → results.
4. **Per-service verification:** generate 2–3 dev posts; assert no hashtags, no Welsh-isms,
   gate passes, snapshot diff reviewed. Assert lead_gen still surfaces the keyword CTA
   (gate `KEYWORD_MISSING` check).

## Phase 3 — Routes dispatch table (~half day)

`routes/generate.js` currently has 20 structurally identical blocks (10 types × streaming SSE
at ~L395–980 + 10 non-streaming at ~L1000–1195): call service → runQualityGate → INSERT
generation_runs → INSERT generated_posts → respond. Replace with:

- `POST_TYPE_DISPATCH` table keyed by recipe slug (label, service fn or engine call, param map).
- One generic handler used by both streaming and non-streaming paths (streaming wraps it with
  sseWrite step events).
- Preserve exactly: `res.json` interception for `stampIdeaCard` + streak (L173–186), SSE `done`
  payload shape, `gateOptions(...)` args, insert column order, `funnel_type`/`post_type` values.

This is also where the Phase 5 retry loop will live (write once, applies to all types).

## Phase 4 — Provenance contract (Pillar 2) (~1 day)

Goal: specifics (numbers, anecdotes, quotes, named outcomes) may only come from AUTHOR-REAL
material. Fixes fake specificity ("20% in 3 months") at the source.

1. **Input tagging.** generate.js assembles `raw_idea` with explicit markers:
   `[AUTHOR-REAL]` = typed input, 2-question answers, vault chunks, extracted facts;
   `[AI-SUGGESTED]` = idea-card hook/context. Frontend `composeIdeaBrief()`
   (public/js/generate.js:2294) already labels these — align wording, don't duplicate.
2. **Core rule** added to authenticityCore: AI-SUGGESTED shapes the angle only; if no real
   proof exists, write the post without a stat. The engine must be told what the
   `CONTEXT FROM THE AUTHOR'S OWN DOCUMENTS` block means (vaultContext.js instruction moves
   into/near the system prompt, not only inside raw_idea).
3. **Idea Engine stops fabricating.** ideaEngine.js:461 — `textarea_input` becomes a
   second-person premise ("You've seen clients who...") never a first-person anecdote.
   Card generation retrieves top vault facts/chunks per pillar first and grounds cards in a
   retrieved fact when one exists (extends the single anchorInsight slot to all LLM cards
   where material is available).
4. **Make auto-extracted facts retrievable (bug).** factExtraction.js inserts vault_ideas with
   no document_id; the RAG fallback (generate.js:334) inner-JOINs vault_documents, so
   auto_extracted + daily_question rows never surface at generation time. Fix: include them
   (LEFT JOIN or UNION), add a ts_rank minimum threshold to the primary chunk search, and
   REMOVE the relevance-free "3 most recent" fallback (inject nothing instead).
   Subsumes roadmap item 04's confidence threshold.
5. **Gate check `FABRICATED_SPECIFIC`.** Deterministic: extract numerals/percentages/
   timeframes/currency from the output; each must appear in AUTHOR-REAL input (normalise
   formatting: "20%" vs "20 percent"). Error-level flag.

## Phase 5 — Quality gate v2 + retry loop (Pillar 3) (~1 day)

New deterministic detectors in qualityGate.js (all regex/countable — keep the "mechanical
checks only" doctrine):

- `TRIAD_FRAGMENTS` — runs of 3+ consecutive fragments <6 words ("No X. No Y. No Z."); warn at
  1 occurrence, error at 2+.
- `ANTITHESIS_DENSITY` — "X wasn't the problem. Y was." / "not an X gap, a Y gap" patterns;
  warn at 2+.
- `LOW_SENTENCE_VARIANCE` — stdev of sentence word-counts below threshold (calibrate on the
  fixture corpus; 360Brew's primary signal).
- `UNIFORM_PARAGRAPHS` — all paragraphs 1–2 lines with identical rhythm.
- `HASHTAGS_PRESENT` — downgrade from "max 3" to warn-on-any (2026: zero or first-comment).
- Roadmap items 06 (external URL in body) and 07 (first-line >140 chars) — same file, do here.
- Express fixes to the model as VARIANCE TARGETS ("mix a 4-word fragment against a 25-word
  sentence"), not new forbidden structures — do not create a counter-template.

**Retry loop** in the Phase-3 generic handler: if error-level or 2+ warn-level authenticity
flags → one regeneration with `qualityRetryHint` naming the exact failures (mechanism already
exists in ideaPath.js:300). Max 1 retry; save best-scoring attempt.

Update tests/qualityGate.test.js + tests/unit/qualityGate.test.js.

## Phase 6 — Goal × format split + structure memory (Pillar 4) (~1–2 days, deferrable)

1. `post_type` currently conflates funnel goal (reach/trust/convert/save) with format
   (story/framework/pis/...). API accepts `{ goal, format }`; legacy values map for backward
   compat (`trust` → `{goal:'trust', format:'authority'}`). Frontend picker + Idea Engine cards
   can then suggest "trust goal, story format". DB: add `format` column, keep `post_type`
   populated during transition.
2. **Structure memory:** store a cheap structure signature per generated post (opener type,
   arc, closer type — regex classification). Generation receives "shapes used in your last N
   posts — do not repeat" block. Extends the existing recentTitles topic anti-repeat to structure.

## Rollout & risk

- **Migration is incremental by design** — one service per commit (Phase 2), routes table after
  all 10 are wrappers (Phase 3). No feature flag needed; each deploy is small and revertable.
- **Hashtags disappear from output** — most visible user-facing diff. Add profile setting
  `include_hashtags` (default OFF) + editor note pointing at first-comment placement.
- **Voice shift is the goal but is abrupt** — posts from the same card read differently
  pre/post. Watch admin dashboard quality trends; expect quality_score scale shift at Phase 5
  (new deductions) — don't compare raw scores across the boundary.
- **Less-punchy stats short-term** (Phase 4): posts stop asserting invented numbers; vault-fact
  retrieval + q_proof answers are what backfill real ones.
- **Do not** rewrite prompts as one mega-prompt with free-text type param; keep
  `buildSubstancePromptForPostType` goal mapping intact.

## Estimates

| Phase | Effort |
|---|---|
| 0 Safety net | 1h |
| 1 Shared core | 0.5d |
| 2 Registry + engine + 10 migrations | 1d |
| 3 Routes table | 0.5d |
| 4 Provenance + vault fixes | 1d |
| 5 Gate v2 + retry | 1d |
| 6 Goal×format + structure memory | 1–2d (deferrable) |

**Total: ~4–5 days** (Phases 0–5 = the authenticity win; Phase 6 is product polish).

## Roadmap items subsumed (linkedin-algorithm-features.md)

- 02 depth score → Phase 1 · 04 confidence threshold → Phase 4 · 06 URL detector → Phase 5 ·
  07 hook char check → Phase 5. Items 08–19 unaffected.

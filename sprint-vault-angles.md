# Sprint: Vault Angles — synthesised posts from bundled insights

*Drafted 2026-07-30. Status: planned, not started. Builds on the shipped per-insight generate path (`23a252e`) and brief mode (`e8e5c62`). Companion: `prd-idea-engine-v2.md` (the questions-not-headlines argument applies to tier 3 supply), `project_input_router_plan` memory (organize-mode fidelity ceiling).*

---

## Problem

One insight produces a shallow post. The shipped path (`POST /api/vault/insights/:id/generate`) grounds a single insight in its source chunk and organises that — better than the old vault path, but the material is one assertion plus surrounding prose. There is nothing for the post to argue *against*, and usually no number.

The naive fix — let users select several insights — fails in a predictable way. A post covering four insights becomes "4 lessons from my case study": breadth, not depth. Coverage and insight pull in opposite directions, and generic multi-point posts are exactly what the algorithm suppresses.

**The reframe: combining means assigning roles, not adding coverage.** One insight is the claim; the others prove it, oppose it, or explain the mechanism.

---

## The role model

The six mined categories already map onto the parts a deep post needs:

| Role | Filled by |
|---|---|
| **spine** — the single claim the post makes | `key_insight`, or the "To:" half of a `mindset_shift` |
| **tension** — what it contradicts | the "From:" half of a `mindset_shift`, or an `advice`/`lesson` asserting the opposite |
| **proof** — the specific | `quote` (verbatim), or any insight carrying a number or named outcome |
| **mechanism** — why it works | `strategy` |
| **consequence** — what to do about it | `lesson`, `advice` |

**An angle is valid only with a spine plus at least one other role filled.** Spine-only is just the existing single-insight path and must not be presented as an angle.

---

## Scope decisions

**Per document, never across documents.** Splicing a number from one engagement onto a claim from another implies a relationship that may not exist. That is a factual-integrity failure, not a quality one, and it is the kind of error that is embarrassing in front of a client who knows both projects. Revisit only with explicit provenance labelling per block.

**Angle count is material-driven.** Return what the insights support — often 2, sometimes 4, sometimes 0. Never pad to a target. A padded fourth angle is the tier-1 idea-card mistake repeated (975 cards → 9 posts): every weak item spends credibility the good item needs.

**Clustering never blocks insight visibility.** `classifyAndStoreDoc` flips `vault_documents.status = 'ready'` in a transaction; angle-building runs as a *second background stage after that flip*. Insights appear immediately; angles land ~20–30s later and the panel updates. Holding `ready` hostage to another Sonnet pass would make upload feel slower for a feature the user has not asked for yet.

---

## Known flaws in this design

Found by walking the workflow end to end before building it. Flaws 1 and 3 change the design and are fixed in the phases below; 2 decides whether the sprint works at all; 4 is a product call, not an implementation one.

### Flaw 1 — "the author's own words" is often false. **Affects shipped code.**

`organizePost` rests on one assertion, stated in its prompt: *"The author told me this, in their own words… preserve their sentences verbatim."* The shipped vault brief says it outright — `[The author's own words, from their document…]`.

But case studies, capability decks, and one-pagers are frequently written by **marketing or an agency**, not by the person posting. The editor then faithfully preserves *agency prose*, retention reports ~0.9, and the product tells the user "94% your words" about copy they did not write. That is the marketing voice the vault exists to escape.

The Voice DNA rules already encode this exact distinction — website copy is deprioritised because *"it is often written by a copywriter"*, while the LinkedIn headline wins because *"it is written by the user themselves."* Documents are the copywriter case; the vault currently treats them as the headline case.

**Fix (Phase 0):** stop asserting authorship. Label document material as source material that may be formally written, and let the editor render it into the author's LinkedIn register from the voice profile rather than preserving it verbatim. This is the opposite of the coach case, where verbatim is exactly right — so the two brief types must not share one label.

**Also needs remediating in the shipped insight endpoint** (`routes/vault.js`), which carries the same false label. Separate small change; do not let it wait on this sprint.

### Flaw 2 — synthesis is composition, assigned to a fidelity tool

Building an argument from four points means deciding the claim and subordinating evidence to it. That is rhetorical construction. `organizePost` cuts, reorders, and joins; by design it does not construct.

Measured evidence: on a 4-block coach brief, draft mode drifted to 0.78–0.84 and invented "we stopped treating the prospect like a form to fill out." An angle brief is **more** disjointed — blocks from different parts of a document rather than answers to related questions — so expect more drift, not less.

And **the two-join cap in brief mode will fight this task.** A four-role argument needs more connective work than two bridges. That cap was tuned for a coach brief and carried into a structurally different job without re-tuning.

**Fix (Phase 3):** treat the generator as an open question, not a settled one. Generate the same angle through (a) brief mode as-is, (b) brief mode with a raised join cap, and (c) the guided writer with `authorRealText` provenance. Read the output and measure retention across ≥5 runs each — single samples cannot separate these, as we learned the hard way.

### Flaw 3 — the plan builds on lossy summaries, then measures the wrong thing

`classifyChunks` condenses: *"every other category may be lightly condensed to one clean sentence."* Only `quote` is verbatim. Insights are therefore already paraphrases.

The original Phase 3 resolved the source chunk for the **spine only**. Tension and mechanism would enter the brief as one-line machine paraphrases with no source passage behind them.

Then the trap: `extractAuthorRealText` strips only `[AI-SUGGESTED]` markers. Condensed insight lines are machine-written and **unmarked**, so retention scores high because the post matches the brief — while part of the brief is the classifier's prose. The number is falsely reassuring, and the gate's fabricated-specific check would validate a figure against a paraphrase that may have rounded it.

Note the shipped endpoint *does* pass the real passage and is grounded. This flaw was introduced by this plan.

**Fix (Phase 3):** resolve the source chunk for **every** roled insight, not just the spine. The insight line becomes a pointer; the passage is the material. Longer brief, correctly grounded.

### Flaw 4 — the author is not in the post. **DECIDED: accepted, not fixed.**

An angle post is 100% document-derived: no first-person stake, nothing about what it cost, what surprised them, or what they would do differently.

A coach-style question before generation was considered and **rejected (2026-07-30)**. No coach intervention on this path. The reasoning holds up: one click with no input is the entire value of the vault surface, and a question in front of it trades away the thing that makes it worth building. The author's stake can still arrive in the **editor**, which is where they land anyway and where they are already editing — that is a better place for it than a gate before generation.

Recorded as a known limitation rather than a to-do: angle posts will read as well-organised material from the author's own work, not as posts only that person could have written. That is a deliberate trade, and the ceiling it implies should not come as a surprise later. If angle→post conversion is healthy but published posts get heavily rewritten in the editor (Phase 5 measures exactly this), that is the signal this trade is costing more than expected — and the place to revisit it.

---

## Phases

### Phase 0 — shared brief builder (prerequisite for everything)

`services/vaultBrief.js`, new. One exported function:

```
buildRoleBrief({ spine, supports, chunks, filename }) -> string
```

Emits explicitly labelled blocks. Note the header — it does **not** claim the material is the author's own words (Flaw 1), and every role carries its source passage, not just the spine (Flaw 3):

```
SOURCE MATERIAL from the author's document "<label>".
This is their work but not necessarily their writing — a case study or deck is
often written formally, or by someone else on their behalf. Their LinkedIn
register is in the AUTHOR VOICE block, and the post must land in that register,
not in the document's. Facts, numbers, names and outcomes are binding and must
be carried across exactly. Phrasing is not: do not preserve corporate or
marketing wording just because it appears below.

SPINE — the claim this post makes:
<insight content>          ← pointer to the point
<its source passage>       ← the actual material

TENSION — what this contradicts:
<insight content>
<its source passage>

PROOF — the specific:
<insight content>
<its source passage>
```

**The role labels are the whole point.** Without them the model reads block 2 as a second topic and produces the listicle this sprint exists to avoid. With them it knows block 2 is in service of block 1.

**The header is the Flaw 1 fix and it is load-bearing.** It separates what is binding (facts) from what is not (phrasing) — the opposite of the coach brief, where phrasing is the thing to preserve above all. The two brief types must never share a header.

Which generator runs is **not settled** — see Flaw 2 and Phase 3.

### Phase 1 — clustering + storage

**Migration 080** (`080_vault_angles.sql`):

```sql
CREATE TABLE IF NOT EXISTS vault_angles (
  id           bigserial PRIMARY KEY,
  user_id      text NOT NULL,
  tenant_id    text NOT NULL DEFAULT 'default',
  document_id  bigint NOT NULL REFERENCES vault_documents(id) ON DELETE CASCADE,
  title        text NOT NULL,        -- a CLAIM, not a topic
  roles        jsonb NOT NULL,       -- { spine: <insight_id>, tension: <id>|null, ... }
  insight_ids  bigint[] NOT NULL,    -- flattened, for "which angles use this insight"
  used_count   integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ... ON vault_angles (document_id);
CREATE INDEX ... ON vault_angles USING gin (insight_ids);
```

`roles` as jsonb rather than a join table: a document yields ~3 angles over ~30 insights, so a join table is premature normalisation. `insight_ids` as an array with a GIN index covers the one reverse query we need (Phase 4).

**`services/vaultAngles.js`**, new. `buildAnglesForDocument(docId, userId, tenantId)`:

1. Load all `vault_insights` for the document (id, category, content).
2. If fewer than 3 insights, return `[]` — not enough to bundle.
3. One Sonnet call with all insights numbered by real id, using `output_config: { format: { type: 'json_schema', schema: ANGLE_SCHEMA } }` per the [ideaEngine pattern](services/ideaEngine.js:484).
4. **Validate every returned insight id against the loaded set.** Models invent ids; a hallucinated reference must drop the angle, not crash it or silently produce an empty block.
5. Drop any angle without a spine + ≥1 other role.
6. Insert surviving angles.

Prompt requirements worth stating explicitly in the system prompt:

- The title must be **a claim someone could disagree with**, not a topic. "Legacy systems fail at integration, not capacity" — not "Legacy systems".
- **No spine may be reused across angles** — the same claim produces the same post. A **support may be reused sparingly**: one strong number legitimately proves two different claims, and a blanket no-reuse rule would both waste it and cap the count at `insights ÷ 2` for no good reason. So the arithmetic ceiling is the number of viable spines (`key_insight` + `mindset_shift`), not half the insight count.
- **At most 4 angles per document.** Not a material limit — a 10-page case study yields 12–25 insights and 5–10 possible spines — but a product one. 975 cards produced 9 posts; a document offering twelve cards is the tier-1 failure with better typography. Two strong angles is a better outcome than five where three are padded, and the prompt must say so outright.
- Prefer supports from a *different* part of the document than the spine. An insight restating the spine adds nothing; one from elsewhere that still bears on it is a genuine second data point.
- Return only angles the material genuinely supports. Returning two strong angles is a better outcome than four where two are padded.

**Re-mine behaviour:** delete the document's angles and rebuild. The FK cascade covers document deletion.

### Phase 2 — panel UI: two tabs, wider panel

Angles do **not** stack above the insight list. Insights and angles are different in kind — insights are reference material you browse, angles are decisions you act on — so a shared scroll gives a few action cards to thirty browsable lines and the action cards scroll away. The panel gets two tabs instead.

```
┌──────────────────────────────────────────────────────────┐
│  london-gateway-case-study.pdf                        ✕  │
├──────────────────────────────────────────────────────────┤
│  ▸ Suggested posts (3)   ·   Insights (12)                │
├──────────────────────────────────────────────────────────┤
│  Post length            [ Short ][ Medium ][ Long ]      │
├──────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────┐  │
│  │ Legacy systems fail at integration, not capacity   │  │
│  │ 3 insights · includes a number                     │  │
│  │ ⌄ what this is built from      [ Generate post → ] │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

**Width: 440px → ~600px.** 440 is genuinely too narrow for a card carrying a title plus three insights with their roles. Mobile is already `max-width: 100vw`, so nothing breaks there.

**Suggested posts is the DEFAULT tab.** The premise of this sprint is that the vault's job is producing posts, not storing reference material. Opening onto Insights buries the feature one level up — the same mistake as the hover-hidden Generate button (`708a9d4`), which was invisible for exactly this reason.

**The document card's label must change with it.** It currently reads `✨ 12 insights organized — tap to view →`, so opening onto a different tab breaks the promise the card just made. New label: `3 post ideas · 12 insights`. When a document has no angles it falls back to the insight-only wording, so the card never advertises something the panel cannot show.

**Counts in both tab labels.** Tells the user whether a tab is worth opening before they click, and does most of the work of surfacing the empty case.

**The empty state is now a first-class screen, not an absent section.** This is the one thing tabs make *harder*. Previously a document with no angles simply rendered nothing and nobody noticed; a dedicated tab cannot do that — an empty tab is a promise broken. And it will be empty often: thin documents, clustering still in flight, and every document mined before migration 073. Keep both tabs always visible (a tab bar that appears and disappears is jumpier than an honest empty state) and say something true:

> **No post ideas from this document.**
> Its insights don't connect into a single argument — that usually means the document covers a lot of ground shallowly. You can still write from any individual insight in the Insights tab.

That names the cause and points at the fallback. The 158-of-176 blank tier-3 cards are the precedent for how badly a silently-empty surface reads: it taught users the surface was broken rather than that this document was thin.

**Cards are EXPANDED by default — the composition is evidence, not detail.** A collapsed card asks the user to trust a headline, which is precisely the form `prd-idea-engine-v2.md` identified as the defect: tier-1 cards were well-written headlines and converted at 0.9%, because a headline gives the reader no way to judge whether anything real sits behind it. A card showing only "Legacy systems fail at integration, not capacity" is indistinguishable from those. Showing the claim, the tension, and the number underneath it makes the difference visible in two seconds — and it is what makes the feature legible in a demo.

To keep height bounded, **clamp each supporting line to two lines** with ellipsis; full text on expand. The `3 insights · includes a number` summary line stays as the at-a-glance signal of whether the post will contain a specific.

**Other behaviour:**

- The `Post length` toolbar stays global to the panel, above the tab content — both tabs generate, so it belongs to neither.
- While clustering is still running, the Suggested posts tab shows one quiet line ("Finding post ideas…"), never a skeleton that may resolve to nothing.
- The Insights tab is unchanged from what ships today, per-insight buttons included. It is the fallback path and stays fully functional.

**Open naming decision.** The label above is written as *Suggested posts*. The originally proposed label was *Post ideas*, which is clearer on first read but collides with an existing concept: the product already has **Ideas** meaning the daily Idea Stream (Ideas tab, ideas pill, `idea_cards`, `vault_ideas`). A "Post ideas" tab in the vault creates a second, different thing called ideas in the UI and a third meaning of the word in the codebase. *Suggested posts* avoids that and is honest that they are suggestions. Either is defensible for the user-facing label — but the internal name stays `vault_angles` regardless of which is chosen.

### Phase 3 — generation from an angle

`POST /api/vault/angles/:id/generate`, body `{ length }`. Mirrors the shipped insight endpoint:

1. Load angle + its insights + **the source chunk for every roled insight** (Flaw 3 — not the spine's alone). Neighbours for the spine only, or the brief balloons.
2. `buildRoleBrief(...)`.
3. Infer post type — the existing Haiku classifier, but fed the spine plus the tension, which should improve it (a spine + its opposite is a much stronger signal for `contrarian` vs `trust` than one sentence).
4. Generate — **generator TBD, this phase decides it.**
5. Quality gate, insert with `source: 'vault_angle'`, bump `used_count`, redirect to editor.

Reuse `resolveInsightChunk` from `routes/vault.js` — it should move into `services/vaultAngles.js` or a shared helper as part of this phase rather than being duplicated.

**This phase is an experiment before it is an endpoint.** Flaw 2 says the editor may be the wrong tool for synthesis and that the two-join cap will fight the task. So build the brief, hand-assemble one angle, and run three arms over ≥5 samples each:

| Arm | Call |
|---|---|
| a | `organizePost(brief, profile, { fromInterview: true })` — as shipped |
| b | same, join cap raised (temporary constant, not shipped) |
| c | `runGuidedGeneration(postType, brief, profile, …)` — the writer, which already passes `authorRealText` |

Compare mean retention, novel-word count, and — the only verdict that matters — **read the posts.** Single samples cannot separate these arms: draft-mode variance alone was 0.78–0.84, wider than the gap between modes. n≥5 per arm, minimum.

Pick the arm, wire it, then move on. If no arm produces posts better than the shipped single-insight path, stop here and do not build Phase 2.

### Phase 4 — collapse the per-insight path into this

The shipped per-insight button stays, but its handler changes:

1. Look up angles containing this insight (GIN index on `insight_ids`).
2. If exactly one, generate from that angle — the user gets the synthesised post without knowing they asked for it.
3. If several, use the one where this insight is the spine, else the first.
4. If none, fall back to the current single-insight behaviour.

This is where original option #1 lands, as ~20 lines rather than its own retrieval subsystem.

### Phase 5 — instrumentation

Log per generation: path (`insight` | `angle` | `angle_via_insight`), roles filled, `retention.score`, gate score.

Two comparisons decide whether this sprint worked:

- **angle→post conversion vs insight→post conversion.** If users click angles over insights, the bundling is doing its job.
- **edit distance between draft and published text, by path.** The measurement already queued in the `project_vault_insight_to_post` memory. If angle posts are edited *less*, they are genuinely better. That is the only real verdict available.

---

## Risks

| Risk | Mitigation |
|---|---|
| **Listicle output** — the failure this sprint is designed around | Role labels in the brief (Phase 0). Verify by reading output before shipping Phase 2, not after. |
| **Retention drift** — bigger briefs give the editor more room to rewrite. Draft mode already measured 0.816 with ~14 invented content words on a 4-block brief, while scoring 100 on the quality gate. | Log `retention` per angle generation from day one. If angle briefs trend toward the 0.7 floor, the floor is the problem, not this feature — see the pending threshold decision in `project_input_router_plan`. |
| **Hallucinated insight ids** | Validate against the loaded set; drop the angle. |
| **The empty tab** — introduced by Phase 2. An absent section goes unnoticed; an empty default tab is a broken promise, and it will be empty for thin documents, in-flight clustering, and every pre-073 document. | Written empty state naming the cause and pointing at the Insights tab. Both tabs always visible. Do not ship the tabs without the empty copy. |
| **Label/default-tab desync** — if the document card still says "12 insights organized" while the panel opens on Suggested posts, the card lies about what is behind it. | The card label and the default tab must ship in the same change, and the label must fall back to insight-only wording when a document has no angles. |
| **Angle staleness** — new documents do not change existing angles, which is correct (per-document scope), but re-mining must rebuild. | Delete-and-rebuild on re-mine. |
| **Padded angles** | Material-driven count; drop spine-only. Log how many the model proposed vs how many survived validation — a widening gap means the prompt is padding. |
| **Cost** | One extra Sonnet pass per document, after `ready`. Negligible against current upload volume; revisit if bulk upload ships. |

---

## Open questions

1. **Backfill existing documents?** Angles only build on mine, so the 6 documents already in prod get nothing until re-mined. Same question as the pre-073 insight backfill — probably one script covering both.
2. **Long documents.** The cap of 4 is right for a case study but wrong for a book or a 100-page report, which genuinely contains more than four arguments — and capping at 4 would draw them all from wherever the strongest insights happen to cluster, ignoring the rest of the document. The fix is not a higher cap but clustering **per section** so angles spread across the material. Deferred: nobody has uploaded a document that long yet. Revisit when someone does, or when bulk upload ships.
3. **Should an angle be regenerable at a different length without re-selecting?** Cheap to add; unclear whether anyone wants it.
4. **Final tab label** — *Suggested posts* (recommended, no collision) vs *Post ideas* (clearer, collides with the Idea Stream). See the naming note at the end of Phase 2. Internal name is `vault_angles` either way.

---

## Order of work

Phase 0 → 1 → 3 → 2 → 4 → 5.

Phase 2 is now the largest phase (wider panel, tab shell, two tab bodies, empty state, card expansion, document-card relabel), which makes the decision to sequence it *after* Phase 3 more important, not less: the tabbed UI is only worth building if synthesised posts actually read better than single-insight ones.

Phase 3 before Phase 2 deliberately: generate from a hand-built angle via curl and read the output before building any UI. If the posts are not better than the single-insight path, the whole sprint is wrong and no UI should exist yet.

# PRD: Idea Engine v2 — Questions, Not Headlines

*Drafted: 2026-07-29. Status: Scoped, not started. Supersedes the card-format decisions in `idea-engine-spec-2026.md` (the supply-ladder architecture there stands). Companion: `sprint-idea-engine-phase1.md`, `sprint-idea-engine-phase2.md`.*

---

## Problem Statement

The Idea Engine has served **975 cards and produced 9 posts — 0.9%**. It is not converting, and at ~40 cards served per user it has taught the ideas surface to be ignorable. Every card served at a 1% rate spends credibility we then need for the card that would have worked.

The diagnosis is not that the cards are badly written. They are well written. The diagnosis is that **the dominant card type asks the user to do the expensive half of the work.**

A tier-1 card reads: *"Client Who Ignored the Spreadsheet."* That is a headline the user must fill. It does the cheap part — choosing a topic — and leaves the expensive part: searching memory for a specific event that fits *the card's* frame, and deciding it is worth saying. If no such memory surfaces, the user skips, or invents one. Inventing is how a post starts sounding like AI, which is the complaint that opened this whole investigation.

A tier-0 card reads: *"What did a client push back on this week — and were they right?"* That is answerable in one line, from memory, without matching anyone's frame. The answer **is** the raw material.

Same topic space. Opposite mechanism. One prescribes, the other pulls.

---

## Evidence (prod, 2026-07-29)

Excluding founder, team, and test accounts — **24 real users**:

| Measure | Value |
|---|---|
| Users who generated ≥1 post | 12 (50%) |
| Users who generated >2 posts | **0** |
| Users who published | 1 (4%) |
| Users who connected LinkedIn | **0** |
| Idea cards served → posts generated | 975 → 9 (**0.9%**) |
| Daily questions served → answered | 261 → **1 (0.4%)** |
| Vault documents uploaded (non-founder) | **1** (6 total, 5 are the founder's) |

Card mix by tier — the supply ladder in [`services/ideaEngine.js`](services/ideaEngine.js):

| Tier | Source | Volume | Share |
|---|---|---|---|
| 3 | Mined from uploaded vault documents | 176 | 17% (158 render blank — see Risks) |
| 2 | Sequel to a post that performed well | 5 | 0.5% |
| 1 | **Invented from the positioning profile** | **495** | **49%** |
| 0 | Daily question | 261 | 26% |

---

## Root Cause

**The supply ladder is designed correctly and every user lands on the bottom rung.**

The ladder tries real material first (tier 3), then performance-derived (tier 2), and only invents (tier 1) when there is nothing real to draw on. That is the right architecture. But vaults are empty, so tier 3 starves; nobody published, so tier 2 has five cards in total. The emergency fallback is doing half the work in the product.

Tier 1 cannot be fixed by writing better headlines, because the headline *form* is the defect. And the two rungs that would displace it are both blocked on inputs the product has no cheap way to collect:

- Tier 3 needs vault documents. "Upload a document" is a project with delayed payoff — **1 non-founder user has ever done it.**
- Tier 2 needs published posts with performance data. **1 non-founder post has ever been published.**

So the loop is closed: no material → invented cards → generic posts → no reason to return → no material.

**The break point is tier 0.** A one-line answer to a good question is the cheapest possible way to get real material into the system, and it is already built. It converts at 0.4% because it is presented as a system placeholder, not because the mechanism is wrong.

---

## Strategic Frame

`public/sign-up-a.html` sells this feature:

> "An Idea Vault stocked with topics matched to your expertise… **Post-worthy ideas waiting every morning**."

and separately promises:

> "ScoutHook interviews you and writes from your own words and ideas, not a template. **It sounds like you because the thinking is yours.**"

Those two promises pull against each other, and the product currently delivers the weaker one. **Making every card a question is what makes both true at once**: an idea is still waiting every morning, matched to the user's expertise — it just arrives in a form that produces their words instead of the model's.

The "Idea Stream" name, section, and screenshot on the marketing site all survive unchanged. This is a change of card *form*, not of product promise.

---

## Goals

1. **Answer rate becomes the primary metric.** ≥15% of served cards answered within 30 days of launch (baseline: 0.4%).
2. **Answers become posts.** ≥40% of answered cards proceed to a generated post in the same session.
3. **The ladder starts climbing.** ≥50% of active users accumulate ≥5 vault entries within 30 days without a manual upload, so tier 3 has real supply.
4. **Reduce served volume without reducing output.** Cards served per user per day drops from 3 to 1, and total generated posts does not fall.
5. **Second-post rate.** ≥30% of users who generate one post generate a second within 14 days (baseline: 0 users have ever exceeded 2).

## Non-Goals

1. **Rewriting the supply ladder.** The tier architecture is correct; only the card form and the tier mix change.
2. **Removing tier 1's topic-selection engine.** Its subject choice is good — it is the rendering that changes. Do not throw away the profile-derived topic model.
3. **Fixing the publish/LinkedIn funnel.** Tier 2 stays starved until that is solved. Out of scope here, tracked separately.
4. **A browsable idea library.** Unchanged from `idea-engine-spec-2026.md` non-goal #3 — ideas come to the user.
5. **Changing marketing copy.** The current promise is compatible; revisit only if the form change proves out.

---

## The Design

### One change, stated plainly

**Every idea card becomes a question. There is no headline card type.**

Tier 1's topic engine keeps selecting subjects from the positioning profile — it is good at that. But instead of emitting `title: "Client Who Ignored the Spreadsheet"`, it emits `question: "Has a client ever ignored your advice? What happened?"`.

Tier 3 (vault-mined) and tier 2 (sequel) convert the same way: a vault insight becomes *"You wrote about X in [doc]. Has that changed?"*; a sequel becomes *"Your post on X did well. What did people get wrong in the comments?"*

### Why this compounds

Today a card is consumed and discarded. After this change, **every answer is material** — stored verbatim as author text, exactly as tier-0 answers already are. That means:

- Tier 3 gains supply without anyone uploading a document. The vault fills by accident, 30 seconds at a time.
- The next day's question can be grounded in yesterday's answer instead of invented.
- The user has visible evidence the product is accumulating something for them, which is the stickiness gap.

This is the same insight as the input router (`services/inputMaturity.js`, commit 12c5f3f): the product should extract the user's words, not compose over them. The Idea Engine is that principle applied one step earlier in the funnel.

---

## Requirements

### R1 — Question-form cards (core)

- `idea_cards.question` becomes the primary display field. `title` is retired for new cards; `hook` retains the post-angle for downstream generation.
- The card renders the question as its headline. No card ships with a placeholder headline.
- **Fixes the existing bug where all 261 tier-0 cards render the literal string "Today's question"** with the real question buried in `hook`.
- Files: `services/ideaEngine.js` (card assembly, all four tier branches), `public/js/idea-cards.js`, `public/ideas.html`, `public/dashboard.html`.

### R2 — Answer capture

- Answering is a single-line input on the card itself. No modal, no navigation, no post-type choice.
- On submit: store the answer verbatim as author material (reuse the tier-0 path — `services/factExtraction.js` and `vault_ideas`), then offer *"Turn this into a post"* as the next action, not an automatic redirect.
- The answer must be visibly retained: *"Saved — this makes tomorrow's question sharper."* Accumulation the user cannot see does not build stickiness.
- Files: `public/js/idea-cards.js`, `routes/ideas.js`, `services/ideaEngine.js`.

### R3 — One card per day

- `CARDS_PER_DAY` drops from 3 to 1 ([`ideaEngine.js:28`](services/ideaEngine.js:28)).
- Rationale: three cards at 1% is three daily lessons that the surface is ignorable. One card that gets answered is a habit. Volume has been actively harmful.
- The dashboard shows one question, not a grid.

### R4 — Answer-first ladder ordering

- Ladder priority becomes: tier 3 (vault-grounded question) → tier 2 (sequel question) → tier 0/1 (elicitation question from positioning).
- Tier 0 and tier 1 merge: both are "a question derived from what we know about you." The distinction between them stops being meaningful once tier 1 is a question.
- `T3_DAILY_CAP` is removed — with one card per day, the cap has no meaning.

### R5 — Generation path

- Answering then generating routes through the existing input router. A one-line answer classifies as `seed` and takes the guided path; a longer answer classifies as `raw` and gets organised.
- **No new generation code.** This is the payoff of commit 12c5f3f — the router already handles both cases correctly.

### R6 — Instrumentation

New `platform_events` types, since the current funnel cannot distinguish "ignored" from "seen and rejected":

- `idea_question_answered` (existing `idea_card_saved` is not the same action)
- `idea_answer_to_post` — answered card → generated post, same session
- `idea_card_skipped` — explicit skip, distinct from never-interacted

Without R6 the goals above are unmeasurable.

---

## Data Model

Migration **080** (079 is the highest applied; note `036` is still not on prod per project memory — confirm before shipping):

```sql
ALTER TABLE idea_cards
  ADD COLUMN IF NOT EXISTS question    text,
  ADD COLUMN IF NOT EXISTS answer      text,
  ADD COLUMN IF NOT EXISTS answered_at timestamptz;
```

- `title` is left in place, unused by new cards. No backfill — the 975 existing cards are historical.
- `is_question` becomes vestigial (every card is a question); leave it, default it true, remove in a later cleanup.

---

## Metrics

Baselines measured 2026-07-29, to be re-measured at 30 days:

| Metric | Baseline | Target |
|---|---|---|
| Cards served → answered | 0.4% | ≥15% |
| Answered → post generated | n/a (1 answer total) | ≥40% |
| Cards served per user per day | 3 | 1 |
| Users with ≥5 passive vault entries | ~0 | ≥50% of active |
| Users generating a 2nd post within 14d | 0 | ≥30% |

**North star for this PRD:** answer rate. Everything else is downstream — if people answer, material accumulates, the ladder climbs, and generation has something real to work with. If they do not answer, no amount of card-quality work will help and the problem is motivational rather than presentational.

---

## Phasing

**Phase 1 — Make it visible (1–2 days).** R1 title fix and R6 instrumentation only. Ship tier-0 questions rendering properly, keep 3 cards/day, change nothing else.

> Deliberately first and deliberately small. It answers the one question this PRD cannot: *does a good question, presented properly, get answered?* If answer rate moves off 0.4% on this change alone, the rest is justified. If it does not, stop — the problem is not the card format, and Phases 2–3 would be building on a wrong premise.

**Phase 2 — Question-form everywhere (3–4 days).** R1 full, R2, R4, migration 080. All tiers emit questions; answers capture and accumulate.

**Phase 3 — Tighten (1 day).** R3 (one card/day), R5 verification, remove `T3_DAILY_CAP`.

---

## Risks & Open Questions

1. **The 158 broken tier-3 cards.** `title IS NULL` and `textarea_input` holds raw JSON (`{"hook":"…`) instead of a plain brief. Served ~975 times. Tracked as a separate task; **fix before Phase 2** or tier 3 emits broken questions too.
2. **False provenance.** Users with zero vault documents are served cards labelled "From your content vault" (verified: user `mannan`, 0 docs, 4 such cards). Fix with #1.
3. **Answer rate may be motivational, not presentational.** Phase 1 exists to find this out cheaply. If a well-presented question still goes unanswered, the constraint is that users do not believe their material is interesting — a positioning problem, not a product one.
4. **Question quality at volume.** One card/day means one shot. A weak question wastes a whole day where three cards previously offered three chances. Needs a quality bar before R3 ships.
5. **Cannibalising the generate box.** If answering a question becomes the main path, the generate page's role narrows. That is probably correct, but it is a bigger change than this PRD scopes.
6. **Sample size.** Every number here comes from 24 users and one month. They are directionally strong (0.4% and 0.9% are not noise) but the targets are estimates, not forecasts.

---

## What Already Exists (build on, don't rebuild)

- `services/ideaEngine.js` — supply ladder, all four tiers, dedup, quality checks
- `services/ideaPrecompute.js` — overnight card generation ("already waiting when you sit down")
- `services/ideaEmails.js` + `idea_email_cadence` — daily delivery, 35 sent, 87 opens (the channel works)
- `services/factExtraction.js` — already stores answers as verbatim author material
- `services/streak.js` — habit mechanic, fires on generate
- `services/inputMaturity.js` — routes answers to organise-vs-write with no new code (12c5f3f)
- `routes/ideas.js`, `public/js/idea-cards.js`, `public/ideas.html` — full serving and rendering surface

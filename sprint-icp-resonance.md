# Sprint — ICP Resonance (root posts in the audience, not just the author)

Written 2026-07-14. Follows the authenticity-pipeline sprint (`sprint-authenticity-pipeline.md`,
Phases 0–4 + gate trim shipped). That work modeled the **author** deeply (Voice DNA, phrase
library, published examples, provenance). This sprint does the same for the **reader**.

**Observed signal (from the user):** posts deeply rooted in the ICP's beliefs, desires,
interests, and problems consistently outperform posts without them. This is consistent with
LinkedIn's 2026 interest-graph shift — content that resonates with a specific audience's beliefs
and problems gets distributed to that interest cluster.

**Diagnosis (verified in code):** we capture the ICP richly but use it shallowly.

- The audience data exists and is passed to all 10 post types via the `TARGET AUDIENCE:` block
  in `services/generationCore.js` (`buildSharedAuthorContext`, ~L209): `audience_description`,
  `audience_goals` (desires), `audience_obstacles` (problems), `audience_core_beliefs_market`
  (beliefs), `audience_buying_stage`, `audience_market_sophistication`. Stored in the
  `audience_profiles` table, joined onto the profile.
- But it is rendered as a **passive bulleted list**. Nothing in the core, engine, recipes, or
  `ideaPath` instructs the model to *root the post in it*. It is context the model may glance at,
  not a constraint it must satisfy.
- **Asymmetry:** the author side is deeply modeled; the reader side is four bullet lines.
- **Passive dump, not selection:** the model gets the whole list, inviting a generic
  "audience-aware" gesture instead of a sharp hit on the one belief/problem the idea speaks to.
- **`audience_buying_stage` / `audience_market_sophistication` do zero steering** today — captured,
  never used to shape the post.
- **"Interests" is not a captured field.** Of the four dimensions named (beliefs, desires,
  interests, problems), three map to columns; interests has no home.

**Strategy:** prompt-first. Convert the audience block from *reference data the model has* into a
*resonance mandate the model must satisfy*, in one shared place so all 10 types inherit it. No
schema or UX change in the core phases. Keep the author's voice primary — root in the reader's
beliefs/problems, but never turn every post into a problem-aware sales pitch.

---

## Phase 1 — Resonance mandate in the shared author context (~2–3h)

**File:** `services/generationCore.js` (`buildSharedAuthorContext`).

Reframe the `TARGET AUDIENCE:` block from a list into a directive. Keep the data lines (they are
the raw material) but precede/follow them with an instruction, e.g.:

> AUDIENCE RESONANCE (non-negotiable):
> This post must land for THIS specific reader — not a generic professional.
> Before writing, pick the ONE belief, desire, or problem below that this idea speaks to most
> directly. Root the whole post in it:
> - Name the problem in the reader's own words, the way they'd describe it to a peer.
> - Mirror how they already think about it — meet them at their current belief, then move it.
> - Tie the payoff to what they actually want, not to what the author sells.
> The reader should feel this was written for them. Do NOT gesture at the whole list — commit to
> the one or two dimensions that fit this idea.

Design notes:
- One place → all 10 recipe types inherit it (engine assembles `buildSharedAuthorContext`).
- It is a *selection* instruction (pick one), which counters the generic-dump failure mode.
- Sits alongside, not inside, the authenticity core — this is reader-rooting, distinct from the
  AI-tell / provenance guards.

## Phase 2 — Goal-calibrated ICP targeting (~2–3h)

**Files:** `services/postRecipes.js` (each recipe already carries `goal`), `services/postEngine.js`
or `generationCore.js`.

Different funnel goals should root in different ICP dimensions. Make the recipe `goal` drive which
audience dimension leads, and finally put `audience_buying_stage` / `audience_market_sophistication`
to work:

| goal | roots primarily in | uses |
|------|--------------------|------|
| reach   | a broad, relatable **problem** or **desire** | obstacles, goals |
| trust   | a **market belief** to challenge or deepen | core_beliefs_market |
| convert | the specific **objection/belief at their buying stage** | buying_stage, beliefs |
| save    | a recurring **problem** they'll want a reference for | obstacles |

Wire `buying_stage` + `market_sophistication` as calibration ("this reader is problem-aware and
stage-3 sophisticated — don't over-explain basics; don't pitch before the belief shift").
Implement as a small goal→emphasis string composed into the resonance block.

## Phase 3 — Deepen ideaPath's audience block (~1h)

**File:** `services/ideaPath.js` (`buildVoiceWritingSystemPrompt`).

The free-form / vault path renders a thinner audience block (only `audience_description`,
`firstObstacle`, `firstBelief`). Bring it up to parity with the Phase 1 mandate so vault and
free-form posts root as deeply as the 10 guided types. Options: (a) reuse a shared resonance-block
builder exported from `generationCore.js`, or (b) mirror the mandate inline. Prefer (a) — single
source, no drift (same principle as the Phase 1 consolidation).

## Phase 4 — Observability: ICP target in synthesis (optional, ~1h)

**Files:** `services/postEngine.js` (synthesis object), frontend editor (display).

Add one line to the returned `synthesis`: which belief/desire/problem this post targeted (the
model states its selection). Lets us *see* whether posts are rooting deeply while tuning, and can
surface a "written for: [the reader's problem]" note in the editor. No behavior change to the post
itself.

## Phase 5 — Capture `audience_interests` (optional, bigger, ~half day)

**Files:** migration (new `audience_interests` column on `audience_profiles`), onboarding /
profile UI, `routes/profile.js` SELECT + upsert, `buildSharedAuthorContext`.

The one named dimension we don't collect. Adds interest-graph hooks (topics/creators/communities
the ICP follows) for the resonance mandate to draw on. Schema + UX change — do only if Phases 1–3
prove the resonance lift and interests are the missing lever.

---

## Verification

- **Unit (DB-free):** extend `tests/unit/generationCore.test.js` / `postEngine.test.js` to assert
  the resonance mandate is present for a fixture profile, that the goal→emphasis mapping renders
  the right dimension per goal, and that it degrades cleanly when audience fields are empty.
- **ideaPath parity:** the byte-identical snapshot in `tests/unit/ideaPathPrompt.test.js` will
  intentionally change in Phase 3 — regenerate the baselines and review the diff (this is a
  deliberate behavior change, not a regression).
- **Real output:** generate a batch across the 10 types for a profile with a full ICP and eyeball
  whether posts name the reader's problem in their words vs generic advice. This is the real test;
  the observed performance lift is the ground truth.

## Risks & guardrails

- **Over-rooting / narrowing reach.** Reach posts win on broad relatability; forcing a narrow ICP
  objection into a reach post can shrink it. Phase 2's goal calibration is the mitigation — reach
  roots in a *broad* problem, not a stage-specific one.
- **Turning every post into a pitch.** Rooting in problems must not become "here's your pain, here's
  my offer." The mandate roots in the reader's *worldview*, and only `convert` posts move toward an
  ask. Keep the author's voice and point of view primary.
- **False precision from thin profiles.** If the ICP fields are sparse, the mandate must degrade to
  "write for the audience described" rather than invent a persona. Guard the same way
  `buildSharedAuthorContext` already no-ops empty sections.
- **Prompt bloat.** This adds to an already-large system prompt. Keep the mandate tight; it rides
  the cached prefix, so cost impact is minimal.

## Non-goals

- No auto-scoring of "ICP fit" in the quality gate (that's the taste-critic direction we removed).
- No new ML/classifier. Prompt-first, deterministic assembly only.
- Not Phase 6 of the other sprint (goal×format split) — orthogonal.

## Estimate

| Phase | Effort | Type |
|-------|--------|------|
| 1 Resonance mandate | 2–3h | prompt (core win) |
| 2 Goal-calibrated targeting | 2–3h | prompt |
| 3 ideaPath parity | 1h | prompt |
| 4 ICP target in synthesis | 1h | optional / observability |
| 5 Capture audience_interests | ~half day | optional / schema+UX |

**Core (1–3): ~1 day.** Phases 4–5 optional, decided after the core proves the lift.

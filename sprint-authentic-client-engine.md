# Sprint: Authentic Client Engine

**Goal:** Close the loop from "AI writes posts" to "ScoutHook turns a founder's real experience into clients" — by fixing the input bottleneck (extraction-first), forcing a human fingerprint on every post (make-it-yours), recommending dwell-heavy formats, learning from real performance, adding the conversation layer that converts readers into clients, and enforcing structural variance so an author's feed never looks machine-stamped.

**Strategic frame:** LinkedIn (360Brew) does not demote AI text — it demotes content with bad behavioral signals: generic language, template structure, low dwell, no substantive comments. The authenticity pipeline (Phases 0–4, provenance contract, integrity gate) already forbids the model from inventing specificity. That means **generation quality is now capped by input quality**, and the reach→client conversion is capped by what happens after publish. This sprint attacks both ends.

**What already exists (build on, don't rebuild):**
- `POST /api/generate/chat-intake` — adaptive brief coach, scores moment/proof/tension/audience, asks one targeted question per gap, max 4 exchanges ([routes/generate.js:1097](routes/generate.js))
- `public/js/voice-input.js` — Web Speech API recorder attached to the generate textarea
- `services/factExtraction.js` — auto-extracts 1 fact/session from raw input into vault_ideas
- `services/tensionExtractor.js` + `/extract-tension`
- `services/linkedinMetrics.js` — likes/comments/reactions sync (manual, 15-min cooldown), `syncWorkspaceMetrics()` written "for future cron jobs" but **no cron worker exists** (workers/ has only workspacePurge.js)
- `routes/performance.js` — manual performance tags (strong/decent/weak) + summary + untagged-published nudge
- `services/postEngine.js` + `postRecipes.js` — single engine, 10 recipes, authenticity core, `fetchPublishedExamples()`
- `services/funnelClassifier.js` — funnel intent classification
- Carousel + Satori visual pipelines (dwell-heavy formats already renderable)
- Idea Engine Phase 2 — daily questions whose answers are stored verbatim as author material

**Migration numbering:** next free number is **077** (073 is duplicated: `073_idea_card_questions.sql` + `073_vault_insights.sql`; 074 is mcp_tokens; 075/076 are the carousel-studio migrations, already committed). So Phase 2/6 telemetry = **077**, Phase 5 post_comments = **078**. Apply 074 to prod before or with this sprint's first migration.

---

## Phase 1 — Extraction-first input ("interview, don't type")

**Why first:** the provenance contract forbids invented specifics, so a thin brief mathematically caps output quality. Talking is ~10x easier than writing for non-writers; every extracted detail is provenance-clean by construction.

### 1.1 Promote the interview to the default path
Today chat-intake is buried inside generate.js frontend logic (`public/js/generate.js:2116`). Restructure the generate page flow:

- New first screen state: **"What happened this week?"** — one big input with the mic button prominent (voice-first framing), plus the existing input_examples chips and Today's-3 idea cards as starters.
- On submit, always run chat-intake (it already fails open and self-limits to 4 exchanges; ready:true short-circuits when 3/4 dimensions present — no added friction for good briefs).
- Render the interview as a chat thread, each question with the mic active by default and the existing `skip_suggestion` as a tappable chip.
- **Files:** `public/generate.html`, `public/js/generate.js` (flow refactor), `public/js/voice-input.js` (reuse as-is; add `initVoiceInput` on dynamically created chat inputs).
- No backend change needed for 1.1.

### 1.2 Structured brief assembly (provenance-aware)
Interview answers currently get concatenated into the raw idea string. Instead, assemble a labeled brief so the engine knows which text is the author's own words:

- New helper in `services/generationCore.js`: `assembleBrief({ initialInput, exchanges })` → returns a single string with labeled sections:
  ```
  RAW IDEA (author's words): ...
  THE MOMENT (author's words): ...
  PROOF / NUMBERS (author's words): ...
  THE TENSION (author's words): ...
  ```
  Only author-typed/spoken text goes in; any AI `skip_suggestion` the user accepted **unedited** is wrapped in the existing `[AI-SUGGESTED]…[/AI-SUGGESTED]` markers so the provenance contract treats it as an angle, never a fact.
- `routes/generate.js` POST `/` accepts optional `interview: { exchanges: [{question, answer, from_skip_suggestion}] }` alongside the raw idea; when present, build the brief via `assembleBrief` and pass that as `rawIdea` to postEngine/ideaPath. Store the exchanges JSON in `generation_runs.input_data` (column exists) for the improve flow and audit.
- **Tests:** unit test `assembleBrief` (labeling, AI-SUGGESTED wrapping, empty sections omitted); integration test that `/api/generate` with interview payload produces a brief containing the labels.

### 1.3 "Talk it out" capture (60–90s voice note → brief)
A separate entry point for founders who have material but no "idea" yet:

- New endpoint `POST /api/generate/structure-brief` — body `{ transcript }` (from Web Speech, so no audio upload/storage needed). Haiku call extracts `{ moment, proof, tension, audience_hook, suggested_post_type, leftover_facts[] }`. Strict rule mirror of factExtraction: extract only what is present, never invent; empty fields are allowed and fed to chat-intake to ask about.
- `leftover_facts` (extra stories mentioned but not used) go to `vault_ideas` as `source='talk_capture'` — one voice note can seed 2–3 future posts. Reuse the insert shape from factExtraction.
- UI: a "🎙 Talk it out" card on generate.html and dashboard: full-screen record state with a soft 90-second guide, live transcript, then "Here's what I heard" review screen (editable fields) → drops into the normal interview/generate flow with fields pre-filled.
- Raise `MAX_FACTS_PER_SESSION` in factExtraction from 1 → 2 (interview flows produce richer input; keep the novelty exclusion list).
- **Files:** `routes/generate.js` (new route), `services/briefStructurer.js` (new, ~120 lines, Haiku), `public/generate.html`, `public/js/generate.js`, `public/dashboard.html` (entry card).
- **Tests:** briefStructurer unit test with a fixture transcript (asserts no invented numbers — feed a transcript with no numbers, assert proof field empty); route test for vault deposit of leftover_facts.

### 1.4 Idea-card and daily-question convergence
Daily-question answers (ideas.js `/question`, `/:id/answer`) are already stored verbatim. Ensure the write path (`/answered/:vaultIdeaId/write`) routes through the same `assembleBrief` labeling so answers count as author-real material. Small change in `routes/ideas.js`.

**Estimate:** 2–3 sessions. 1.1+1.2 first (pure UX + labeling, biggest lift/effort ratio), then 1.3.

---

## Phase 2 — The "Make It Yours" pass (60-second human fingerprint)

**Why:** never let a post ship untouched. Human sentences at the hook/punchline positions break template rhythm exactly where dwell time is decided, and ownership changes how the founder engages in comments.

### 2.1 Span-suggestion service
- New `services/makeItYours.js`: `suggestPersonalSpans(postText, profile)` → Haiku call returning 2–3 spans:
  ```json
  [{ "excerpt": "exact sentence from the post", "slot": "hook|punchline|bridge",
     "why": "one line: why this needs your own words",
     "prompt": "question to the author, e.g. 'How would you actually say this out loud to a client?'" }]
  ```
  Always include the hook; include the final-third punchline when present. `excerpt` must match the post verbatim (validate server-side with `indexOf`; drop non-matching spans).
- New endpoint `POST /api/generate/make-it-yours` — body `{ postId?, postText }`, returns spans. Non-blocking design: on any error return `{ spans: [] }` and the UI skips the step.

### 2.2 Editor UI step
- After generation (generate.html result state and editor.html), show a **"Make it yours — 60 seconds"** panel: each span rendered highlighted in the post preview; tapping opens an inline input pre-focused with the coach `prompt`, mic button attached (`initVoiceInput`). Replacing text swaps it into the draft. "Skip" allowed, but the publish/schedule button shows a subtle state ("Posting as pure AI draft") until at least one span is edited.
- Keep it *fast*: no modal maze — one panel, three taps max.
- **Files:** `public/generate.html`, `public/js/generate.js`, `public/editor.html` (result panel; editor.html is 4.6k lines — isolate as a new self-contained `public/js/make-it-yours.js` included by both pages).

### 2.3 Edit telemetry
- **Migration 077:** `ALTER TABLE generated_posts ADD COLUMN human_edit_chars INTEGER DEFAULT 0; ADD COLUMN miy_spans_edited INTEGER DEFAULT 0;`
- Frontend reports edit distance on save/publish (simple char-diff between generated and final text — a ~15-line Levenshtein-lite or just length-of-changed-regions is fine; precision doesn't matter, direction does).
- Log `platform_events` `('miy_completed', spans_edited)` for the admin funnel report.
- Later (Phase 4) correlate `miy_spans_edited` with performance — this becomes the in-product proof that "posts you touched perform better."

**Estimate:** 1–2 sessions.

---

## Phase 3 — Format recommendation (dwell-time steering)

**Why:** document/carousel and visual posts hold attention 3–10x longer than text; dwell is the ranking currency. The renderers already exist — the gap is that format choice is left to the user.

### 3.1 Recommender
- Extend `services/funnelClassifier.js` (or add `recommendFormat()` beside it): given the brief + post_type, return `{ format: 'text'|'carousel'|'visual'|'text+visual', reason }`. Heuristic-first, LLM only if needed:
  - framework / how-to / listicle shape → carousel
  - results with a strong number → text + metrics-card visual (metricsCardGenerator exists)
  - story / contrarian / goodwill → text (narrative dwell comes from the writing)
  - quote-worthy one-liner detected → optional branded quote card
- Pure function + small unit test; no migration.

### 3.2 Surface it
- Chip on the generate result screen: *"This idea would land harder as a carousel — frameworks get saved, and saves are the strongest ranking signal."* One click hands off to the existing carousel/visual pipelines with the brief pre-filled.
- Log accept/reject to `platform_events` (`format_reco_accepted`) so Phase 4 can validate the recommender against real performance.
- **Files:** `services/funnelClassifier.js`, `routes/generate.js` (include reco in generate response), `public/js/generate.js`.

**Estimate:** 1 session.

---

## Phase 4 — Close the performance loop

**Why:** per-author learning compounds — the longer a founder stays, the better their posts get. No one-shot generator can copy this. It is both a quality engine and the retention story.

### 4.1 Nightly metrics sync worker
- New `workers/metricsSync.js` following the workspacePurge.js pattern: iterate workspaces with valid LinkedIn connections, call `syncWorkspaceMetrics()` (already handles cooldown, rate-limit early-stop). Schedule nightly; stagger workspaces (e.g. 2s gap) to respect LinkedIn 429s. Wire into whatever runs workspacePurge (check server.js/Procfile at implementation time).
- Only syncs posts published in the last 30 days (add `AND published_at > datetime('now','-30 days')` to the batch query — engagement flatlines after that; saves API quota).

### 4.2 Performance insights service
- New `services/performanceInsights.js`: per workspace, aggregate `generated_posts` (status=published) by `format_slug`/post type, funnel_type, and content pillar (match against `profiles.content_pillars` via the stored idea_input — cheap keyword match, don't over-engineer):
  - engagement score per post = `reactions + 3*comments` (comments weighted — they're the client-conversation signal), normalized against the author's own trailing median (author-relative, never cross-user).
  - Blend the manual `performance_tag` (strong=+1 band, weak=−1 band) — it captures impressions/DMs the API can't see.
  - **Minimum sample guard:** no insight until ≥6 published posts and ≥3 in a bucket; otherwise return `{ insufficient_data: true }`. Shipping "your story posts outperform" off n=2 destroys trust.
- Output shape: `{ topFormat, topPillar, laggingFormat, insights: [{ text, evidence }] }`.

### 4.3 Feed it back (three consumers)
1. **`fetchPublishedExamples` weighting** (ideaPath.js): prefer the author's top-engagement published posts as style examples instead of most-recent. One query change + tie-breaker on recency.
2. **Idea supply bias:** `ideaPrecompute`/`ideaEngine` weight Today's-3 toward the winning pillar/post-type (e.g. 2 of 3 cards from winners, 1 explorer card to keep discovering). Guarded by the sample minimum.
3. **Dashboard "What's working" card** + a line in the daily idea email: *"Your story posts get 4x the comments of your how-to posts — today's first idea is a story."* Files: `public/dashboard.html`, `public/js/dashboard.js`, `services/ideaEmails.js`.
- New route `GET /api/performance/insights` in `routes/performance.js`.

### 4.4 Honest constraint (document in code comment + admin)
LinkedIn's member API exposes reactions/comments only — **no impressions/dwell for member posts**. The manual performance tags remain the impressions proxy; keep the untagged-published nudge prominent (it feeds 4.2 directly).

**Estimate:** 2 sessions. 4.1+4.2 together, then 4.3.

---

## Phase 5 — The conversation layer (posts → conversations → clients)

**Why:** for a B2B founder the funnel is post → profile visit → DM. Reach without conversation converts nobody. This moves ScoutHook from "content tool" to "client-acquisition system" — the pricing-power story.

### 5.1 Comment retrieval (spike first — API risk)
- **Risk:** reading comments requires `r_member_social` / Community Management API access, which is gated by LinkedIn partner approval — the current scopes (posting + socialMetadata counts) may not cover it. **Do a half-session spike:** attempt `GET /rest/socialActions/{shareUrn}/comments` with the current token; if 403, apply for the scope and build 5.2 in paste-mode first.
- If available: extend `services/linkedinMetrics.js` with `fetchPostComments(accessToken, shareUrn)`; store in new table (**migration 078**) `post_comments (id, tenant_id, post_id, linkedin_comment_id UNIQUE, author_name, author_headline, text, created_at, replied BOOLEAN DEFAULT 0)`. Sync in the nightly worker for posts <7 days old.

### 5.2 Reply drafts ("Engage" tab)
- New `services/replyDrafts.js`: given a comment + post + profile, draft a substantive reply in the author's voice. Rules mirror the authenticity core: no "Great point!", must add one real thought or question, ≤3 sentences, provenance contract applies (no invented claims). Use Sonnet with the shared author context from generationCore.
- UI: "Engage" section on the published-posts page (`public/published.js` exists): new comments listed with a suggested reply → **copy to clipboard** + deep link to the post. Do NOT auto-post replies in v1 — a founder pasting a reply stays authentic and stays inside LinkedIn ToS comfort zone; revisit API posting after usage data.
- **Paste-mode fallback** (if 5.1 blocked): the Engage tab shows recent published posts with a "paste a comment you got" box → same reply-draft output. Less magical, still valuable, ships regardless of LinkedIn approval.
- Route: `GET /api/performance/engage-queue`, `POST /api/performance/reply-draft`.

### 5.3 DM opener suggestions
- For commenters (from 5.1 data) whose comment signals intent (question about the topic, "we struggle with this too"), offer a one-tap DM opener draft: references their specific comment, offers value, no pitch. Copy-to-clipboard only — never automated, ever (ToS + authenticity).
- Cheap add once 5.2 exists: same service, different prompt mode (`mode: 'dm_opener'`).

### 5.4 Profile-as-landing-page audit
- One-time (re-runnable) audit: user pastes headline + About (the OAuth basic profile doesn't expose About text — paste is fine, it's a 20-second copy). New endpoint `POST /api/profile/linkedin-audit` → Sonnet scores against their ICP (audience_profiles) + offer: does the headline say who you help and to what outcome? Does About end with a clear next step? Returns 3–5 concrete rewrites in their voice.
- Surface at onboarding completion and as a dashboard card: *"Your posts send people to your profile. Make sure it converts."*
- **Files:** `routes/profile.js`, new `services/profileAudit.js`, `public/js/settings.js` or dedicated card.

**Estimate:** 2–3 sessions (5.1 spike + 5.2 paste-mode + 5.4 first; comment-sync mode when scope is approved).

---

## Phase 6 — Structural variance enforcement

**Why:** each post can pass the gate while the *feed* still looks machine-stamped — same hook shape, same rhythm, same recipe cadence. Aggregate pattern is a classifier signal and a reader-boredom signal.

### 6.1 Hook-shape fingerprint
- New pure function in `services/generationCore.js`: `classifyHookShape(firstLine)` → one of ~8 classes via regex/heuristics: `question | number_lead | contrast ("X but Y") | confession ("I was wrong…") | statement | quote | second_person ("You…") | scene ("Last Tuesday…")`. No LLM needed.
- **Migration 077 (same file as Phase 2):** `ALTER TABLE generated_posts ADD COLUMN hook_shape TEXT;` — stamp at generation time.

### 6.2 Anti-repetition injection
- In `postEngine.generate()` (and ideaPath), query the last 5 published/scheduled posts' `hook_shape` + first lines; when the last 2 share a shape, append to the user prompt:
  ```
  RECENT HOOKS (do not reuse these shapes or rhythms):
  - [shape] "first line…"
  Open this post a different way.
  ```
  Cheap, cache-friendly (goes in the user prompt, not the cached system prefix).

### 6.3 Recipe cadence guard
- In the scheduling/generate flow: if the same recipe slug was used for the last 2 posts, surface a nudge ("3rd framework post in a row — mix in a story?") and have Today's-3 enforce type diversity (likely partially true already in ideaPrecompute — verify at implementation).
- Post-publish check is UI-level only; never hard-block.

**Estimate:** 1 session.

---

## Phase 7 — Positioning (marketing, no code)

Reposition around the moat this sprint completes: **"The ghostwriter that only writes from your real life."**
- Landing-page narrative: everyone else generates content; ScoutHook interviews you (Phase 1), refuses to invent (shipped provenance contract), makes you touch every post (Phase 2), learns from your results (Phase 4), and turns readers into conversations (Phase 5).
- Name the enemy explicitly: "AI slop gets 2% reach. Lived experience gets clients."
- In-product proof point once Phase 2+4 data exists: "Posts you personalized got Nx more comments."

---

## Execution order & sequencing

| Order | Phase | Sessions | Ships user value on its own? |
|---|---|---|---|
| 1 | 1.1–1.2 Interview-default + labeled briefs | 1–1.5 | Yes — better posts immediately |
| 2 | 2 Make It Yours | 1–2 | Yes |
| 3 | 1.3 Talk-it-out capture | 1 | Yes |
| 4 | 4.1–4.2 Metrics worker + insights | 1 | Silent (data accrues) |
| 5 | 3 Format reco | 1 | Yes |
| 6 | 4.3 Feedback consumers | 1 | Yes — needs 4.1 data ≥1 week |
| 7 | 6 Variance | 1 | Yes |
| 8 | 5 Conversation layer | 2–3 | Yes (start spike early — LinkedIn approval lead time) |

**Do the 5.1 scope spike in the first week** (30 min) so any LinkedIn partner-approval clock starts immediately, even though the build lands last.

## Cross-cutting rules

- **Tests:** every new service gets a unit test; test-branch isolation is mandatory (`.env.test` + Neon test branch) per standing rule. New prompts get the fixture-based "no invented numbers" assertion pattern.
- **Migrations:** 077 (human_edit_chars, miy_spans_edited, hook_shape), 078 (post_comments). 075/076 are the already-committed carousel-studio migrations; confirm 074 (mcp_tokens) is applied to prod first.
- **All new LLM calls** fail open (return null/empty, never block generation) and follow the existing key-resolution pattern (`process.env.ANTHROPIC_API_KEY || getSetting`). Haiku for extraction/classification, Sonnet for anything the user reads as "writing."
- **Provenance discipline everywhere:** any AI-suggested text a user accepts unedited is `[AI-SUGGESTED]`-wrapped; reply drafts and DM openers obey the same no-invented-claims core.

## Success metrics (checked at Phase 4.3 + 4 weeks)

1. Median brief length (chars of author-real material per generation) — expect 2–3x.
2. % of published posts with ≥1 Make-It-Yours span edited — target >70%.
3. Author-relative engagement of interview-path posts vs typed-path posts.
4. Comments per post trend (the client-conversation proxy) per workspace.
5. Retention: workspaces publishing ≥2 posts/week at week 8.

# Sprint — First Post Flow (`/start` v2)

**Goal:** a signed-up stranger reaches a scheduled or published post in one sitting.

**Current prod baseline (measured 2026-08-15, 30 days):**
106 signups → 37 verified → 19 reached `/start` → 8 connected LinkedIn → 6 generated → **1 published.**

**Target metric:** *first schedule or publish within 24h of signup.* Nothing else is the goal — not generations, not idea taps.

---

## The shape

```
Who you are  →  3 ideas  →  one question  →  post  →  schedule
  (2 fields)     (tap)       (type/voice)              (LinkedIn asked HERE)
```

The user sees output from ScoutHook (three ideas about their world) **before** being asked for anything hard. The tapped idea makes the single question specific, which is the whole point: the blank page is frightening because it is unspecific, not because typing is hard.

---

## Decisions already taken

| Decision | Rationale |
|---|---|
| Editor route untouched | `organizeMode` wins unconditionally at `routes/generate.js:507`; passing an explicit `post_type` flows to `organizePost({postType})` → `TYPE_SHAPES[postType]`. No change to the generator. |
| One question, not two | The tapped idea supplies the specificity a second question would have. |
| Three ideas, not six options | The three ideas *are* the options. No separate post-type tap; the user never sees the taxonomy. |
| Clean slate on the Idea Engine | That code is being removed. Nothing here depends on it, and `idea_cards` is left behind. |
| The idea is steering, never material | An AI-written hook must not be counted as the author's words. See "The steering handoff". |

---

## What is NEW

### 1. Migration — `087_starter_ideas.sql`

```sql
CREATE TABLE starter_ideas (
  id          bigserial PRIMARY KEY,
  user_id     text        NOT NULL,
  tenant_id   text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  batch_id    uuid        NOT NULL,     -- the three ideas from one call
  position    smallint    NOT NULL,     -- 1..3, display order
  hook        text        NOT NULL,     -- the idea, as shown on the card
  angle       text,                     -- one line of "why this lands", small type
  post_type   text        NOT NULL,     -- MUST be a TYPE_SHAPES key
  question    text        NOT NULL,     -- the single question asked after the tap
  chosen_at   timestamptz,              -- set on tap; NULL = shown, not taken
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_starter_ideas_batch ON starter_ideas (batch_id);
CREATE INDEX idx_starter_ideas_user  ON starter_ideas (user_id, created_at DESC);

ALTER TABLE generated_posts
  ADD COLUMN starter_idea_id bigint REFERENCES starter_ideas(id) ON DELETE SET NULL;
```

`chosen_at` being nullable is deliberate: shown-but-not-tapped is the row that tells you the ideas were weak.

**Dependency on the Idea Engine removal:** dropping `idea_cards` requires dropping `generated_posts.idea_card_id` (FK `generated_posts_idea_card_id_fkey`) first. That belongs to the removal work, not this sprint, but the two must not collide — land this migration *after* the drop, or the two ALTERs will fight over the same table.

### 2. `services/starterIdeas.js`

One function, one model call, three ideas.

```js
generateStarterIdeas({ expertise, audience }) -> [
  { hook, angle, post_type, question },   // ×3
]
```

Rules baked into the service:

- **One call.** Not a pain-point library, not a multi-stage pipeline. Latency here is drop-off, and this fires at the most fragile moment in the funnel. Budget ≤5s.
- **`post_type` must validate against `TYPE_SHAPES` keys** (`story`, `lessons_learned`, `bts`, `contrarian`, `framework`, `results`, `trust`, `pis`, `lead_gen`, `reach`). Anything else is coerced to `story`. **`announcement` is a trap** — it exists in `POST_TYPE_DISPATCH` but *not* in `TYPE_SHAPES`, so it would silently fall through to `TYPE_SHAPES.reach`, the vaguest instruction available, with no error.
- **Three different shapes** across the three ideas, so the user is choosing between genuinely different posts rather than three phrasings of one.
- **The `question` is authored with the idea**, not templated from the shape. A question that references the idea's specifics is what makes it easy to answer.
- **Fails open.** If the call errors or times out, skip the ideas screen and fall through to today's single generic question. The flow must never dead-end on an LLM.

### 3. Endpoints

| Route | Does |
|---|---|
| `POST /api/start/profile` | `{ expertise, audience }` → writes `brand_voice_profiles.brand_description` + `audience_profiles.audience_description` for the default profile |
| `POST /api/start/ideas` | Reads the saved profile, calls `generateStarterIdeas`, persists a batch of 3, returns them |
| `POST /api/start/ideas/:id/choose` | Stamps `chosen_at`. Fire-and-forget — a failure here must not block the user |

Generation itself stays on the existing `POST /api/generate`.

### 4. Screens in `start.html` / `start.js`

Three new entries in the `SCREENS` array: `who`, `ideas`, and a reworked `ask`. The existing `signin`, `cook`, `post`, `earn` screens and the whole state machine stay.

---

## What is REUSED (unchanged)

This is most of the system. Nothing below gets edited.

**Generation**
- `POST /api/generate` with `generation_mode: 'organize'` — the editor route, untouched
- `services/organizePost.js` — `EDITOR_SYSTEM`, `EDITOR_HOOK_RULES`, `TYPE_SHAPES`, the retention retry
- `pickPostShape()` still serves every other caller; `/start` simply stops needing it, because the user's tap is better information than a regex over their words
- `services/retention.js` + `enforce_retention: true`
- `runQualityGate` / `FABRICATED_SPECIFIC` / `extractAuthorRealText`
- `buildSharedAuthorContext` — starts working properly the moment Phase 1 fills the brand/audience fields it reads

**The steering handoff (the important reuse)**
- `assembleBrief()` (`services/generationCore.js:161`) with `AI_SUGGESTED_OPEN`/`CLOSE` markers

**Front end**
- `initVoice()` — the mic already exists on this page; it gets promoted to the primary input
- `readStash`/`clearStash` — the LinkedIn publish-scope round trip that preserves a finished post
- `st-modal` publish-scope upgrade (`start.html:286`), confetti, `generationErrorMessage`
- The **thin-input safety net** at `start.js:395` — stays exactly as is

**Auth / billing / telemetry**
- `SCOPE_READ` vs `SCOPE_PUBLISH`, `connect?from=start_publish`
- `canGeneratePost` free-tier cap
- `signup_conversion_fired_at`

---

## The steering handoff

The one thing that will silently break the product if done wrong.

The tapped idea is **AI-written**. If it is concatenated into `raw_idea` as though the author said it, retention scoring counts those words as the author's, and "these are your words" becomes false at the exact moment someone decides whether to put their name on it.

Use the machinery that already exists for this:

```js
const raw_idea = assembleBrief({
  initialInput: answer,                       // the author's words → "RAW IDEA (author's words)"
  exchanges: [{
    question: 'Angle',
    answer: idea.hook,
    from_skip_suggestion: true,               // → wrapped in [AI-SUGGESTED] … [/AI-SUGGESTED]
  }],
});
```

`extractAuthorRealText` strips the markers before retention scoring, and the `FABRICATED_SPECIFIC` gate already understands them. Steering in, no facts.

Generate call from `/start`:

```js
{
  path: 'idea',
  raw_idea,                          // assembled as above
  post_type: idea.post_type,         // was 'auto' — now the idea's classification
  generation_mode: 'organize',
  enforce_retention: true,
  source: 'start_flow',
  brief_mode: false,                 // single author answer, no seams to join
  starter_idea_id: idea.id,
}
```

---

## UI

```
┌─ SCREEN 1 ── who ────────────────────────┐   ┌─ SCREEN 2 ── ideas ──────────────────────┐
│                                          │   │                                          │
│  Let's find something worth posting.     │   │  ScoutHook came up with 3 ideas          │
│                                          │   │  for your first post.                    │
│  What do you do?                         │   │                                          │
│  ┌────────────────────────────────────┐  │   │  ┌────────────────────────────────────┐  │
│  │ I help B2B SaaS founders fix their │  │   │  │ Most onboarding emails die at   ▸ │  │
│  │ onboarding emails                  │  │   │  │ step three. Nobody checks why.     │  │
│  └────────────────────────────────────┘  │   │  │ ─ a problem your buyers feel ─      │  │
│   try: "marketing" · "sales coaching"    │   │  └────────────────────────────────────┘  │
│                                          │   │  ┌────────────────────────────────────┐  │
│  Who do you want to reach?               │   │  │ The client who almost churned,  ▸ │  │
│  ┌────────────────────────────────────┐  │   │  │ and the one email that fixed it    │  │
│  │ Early-stage founders               │  │   │  │ ─ a story only you can tell ─       │  │
│  └────────────────────────────────────┘  │   │  └────────────────────────────────────┘  │
│   try: "founders" · "CMOs" · "coaches"   │   │  ┌────────────────────────────────────┐  │
│                                          │   │  │ Why "just add a nurture       ▸ │  │
│           [  Show me ideas  ]            │   │  │ sequence" is bad advice            │  │
│                                          │   │  │ ─ a take worth arguing with ─       │  │
│  ── two lines. nothing else. ──          │   │  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘   │                                          │
                                               │        Tap an idea to continue           │
    ↓  one call, ~3-5s, skeleton cards         │        none of these fit? ↻ again        │
                                               └──────────────────────────────────────────┘

┌─ SCREEN 3 ── ask ────────────────────────┐   ┌─ SCREEN 4 ── post ───────────────────────┐
│                                          │   │                                          │
│  ┌──────────────────────────────────┐    │   │  ┌────────────────────────────────────┐  │
│  │ Most onboarding emails die at    │    │   │  │ ◯  Your Name                       │  │
│  │ step three. Nobody checks why.   │    │   │  │    Your headline · now             │  │
│  └──────────────────────────────────┘    │   │  │                                    │  │
│                                          │   │  │  We spent six weeks rewriting      │  │
│  One question:                           │   │  │  copy nobody was reading.          │  │
│                                          │   │  │                                    │  │
│  When did you last watch this happen     │   │  │  ░░ their own sentences shown ░░   │  │
│  to a client?                            │   │  │  ░░ highlighted / underlined  ░░   │  │
│                                          │   │  │                                    │  │
│         ╭──────────────╮                 │   │  └────────────────────────────────────┘  │
│         │      ◉       │   ← mic is      │   │                                          │
│         │   tap to     │     PRIMARY     │   │   84% your words. We moved three and     │
│         │    talk      │                 │   │   cut the rest.                          │
│         ╰──────────────╯                 │   │                                          │
│                                          │   │   ┌──────────────────────────────────┐   │
│   60 seconds is perfect.                 │   │   │  Schedule for Tue 9:00 AM        │   │
│                                          │   │   └──────────────────────────────────┘   │
│   or type it instead ▾                   │   │        Publish now  ·  Save to drafts    │
│                                          │   │                                          │
└──────────────────────────────────────────┘   │   ↑ LinkedIn permission asked HERE        │
                                               └──────────────────────────────────────────┘
```

**Screen 3 notes.** The chosen idea stays pinned at the top so the user is answering *about that idea*, not into a void. The mic is the primary control and the textarea is a disclosure — people narrate when they speak and abstract when they type, and speech yields ~140–200 words against a measured 55-word typed median. The copy asks for 60 seconds, not "thirty seconds is plenty", which caps the one variable that most determines whether the post can be good.

**Screen 4 notes.** The retention score is computed today and thrown away — it isn't even a column. Surfacing it as "84% your words" is the cheapest available aha and it doubles as permission to publish: it reframes the post from "an AI wrote this" to "you wrote this, I arranged it." **This requires persisting retention on `generated_posts`** (add to the migration if you want it measurable over time).

---

## Phases

**Phase 0 — decision, blocks everything**
Where does the LinkedIn ask sit? Today `/start` opens on "Continue with LinkedIn" and it costs **95% of verified users** while buying only a name and an avatar (identity scope yields no posts, so there is nothing to mine for voice). Every screen above assumes the ask moves to the schedule button. If the wall stays in front, the rest of this sprint is decoration.

**Phase 1 — profile capture** *(no AI, ships alone, useful immediately)*
Screen 1 + `POST /api/start/profile`. Fills `brand_description` and `audience_description`, currently empty on **21 of 21** recent workspaces, which means `AUDIENCE RESONANCE (non-negotiable)` in the generator prompt has nothing to bite on. This improves every post those users ever generate, independent of the rest.

**Phase 2 — starter ideas**
Migration + `services/starterIdeas.js` + `POST /api/start/ideas` + screen 2. Ships behind a flag; fails open to today's flow.

**Phase 3 — idea → question → generate**
Screen 3, the `assembleBrief` steering handoff, explicit `post_type`, mic promoted to primary. Keep the thin-input safety net.

**Phase 4 — measurement**
`starter_idea_id` on posts, persist retention + shape, and a funnel view: batch shown → tapped → generated → scheduled.

**Phase 5 — optional**
"Another angle" — regenerate from the identical answer in a different shape. One extra call, no extra user input, and it is the cheapest "I didn't expect that" beat available.

---

## Risks

| Risk | Mitigation |
|---|---|
| **Generic ideas.** "Marketing" + "Founders" produces three ideas that could belong to anyone — the opposite of an aha. | Free text, not a taxonomy. Example chips as seeds. Enforce a minimum length on the expertise field; the specificity of all three ideas is bounded by it. |
| **Latency at the most fragile moment.** | One call, ≤5s budget, skeleton cards while waiting, hard timeout that falls through to the generic question. |
| **AI hook contaminates "your words".** | The `[AI-SUGGESTED]` handoff. Verify retention distribution against the pre-change baseline before rollout. |
| **Thin answers still produce thin posts.** | Existing safety net at `start.js:395` stays. "Uses whatever inputs are available" must never mean "generate regardless" — five words plus an AI hook is a fabricated post under a real name. |
| **Bot traffic burns LLM spend.** Aug 14 brought ~83 signups in 30h, 81/82 gmail bot-farm addresses. | Ideas only after email verification; per-user and per-IP rate limits before any anonymous generation. |
| **Unreadable results.** The `prospecting_aug26` cohort is bot-grade; an A/B read off it means nothing. | Measure against organic traffic, or pause the campaign for the read. |
| **Migration collision** with the Idea Engine removal (`generated_posts.idea_card_id` FK). | Land `087` after the drop. |

---

## Open questions

1. **Does the LinkedIn wall move?** Phase 0. Everything else is downstream.
2. **Model for the ideas call.** Three hooks are the entire first impression and this runs once per user — Sonnet is probably right despite the cost, but worth measuring against Haiku.
3. **Regenerate limit.** "None of these fit? ↻" is honest, but uncapped it's a free generation loop for bots. Cap at one.
4. **Persist retention?** Needed for screen 4's "84% your words" to be measurable rather than merely displayed. Small addition to `087`.

---

*Written 2026-08-15. Baseline numbers measured against the prod Neon branch on the same date.*

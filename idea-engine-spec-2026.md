# ScoutHook — Idea Engine Spec

*Drafted: 2026-07-11. Status: Approved direction, pending sprint scoping. Companion docs: `product-roadmap-2026.md` (roadmap items #6, #8, #9, #11), `competitive-intel-2026.md` (competitor mechanics referenced throughout).*

---

## Problem Statement

Consultants know consistent posting drives visibility, but most have no idea what to write on any given day — and ScoutHook currently makes them originate the idea before it delivers any value. The generate page opens with a 10-card post-type taxonomy and a blank textarea: three decisions before the first payoff. The result is blank-page syndrome inside the product that was supposed to cure it, showing up as irregular posting cadence and sessions that end without a generated post.

Every winning competitor (Supergrow, Postiv, FeedBoss, ContentIn) has inverted this: **the product supplies the idea; the user only reacts.** Reacting (pick / tweak / reject) is cognitively cheap. Originating is expensive. The cost of not solving this is churn to tools that greet users with ready-made starting points — while ScoutHook's unique idea source (the vault) sits buried behind a button on a page users reach only after already committing to write.

**Core design principle for everything below:** never ask the user "what do you want to post about?" as the opening move. Show them what they could say, sourced from their own material, and let them react.

---

## Strategic Context

- The blank-page fix and ScoutHook's moat are the same feature. Competitors source ideas from other people's viral posts (Taplio, Kleo) or generic niche trends (FeedBoss). ScoutHook sources ideas from the user's own documented expertise — unrejectable in a way trending topics never are, and every idea consumed deepens vault investment and switching cost.
- Habit-loop research (Duolingo): users at a 7-day streak are ~2.4× more likely to return next day; when Duolingo lowered the daily bar to one minimal action, 7-day+ streaks rose >40%. Implication: the daily habit action must be tiny (save an idea), never "publish a post."
- North-star metric: **% of generated posts that started from a served idea vs. a typed idea.** This one ratio says whether the Idea Engine became the habit loop or decoration.

---

## Goals

1. **Every login starts with ideas, not a blank input** — 100% of dashboard sessions render 3 ready idea cards, regardless of vault state.
2. **Served ideas become the dominant path to posts** — ≥40% of generated posts originate from a served idea within 60 days of launch (stretch: 60%).
3. **Raise posting consistency** — median posts/week per active user up 25% within 90 days.
4. **Grow the vault passively** — ≥50% of active users accumulate ≥5 auto-extracted vault entries within 30 days, without a manual upload.
5. **Create a daily return trigger** — DAU/WAU ratio improves measurably after email + streak ship (baseline to be captured pre-launch).

## Non-Goals

1. **Viral post swipe library (Taplio-style).** Most-copied mechanic in the category, unsustainable curation cost without partner API access, and it trains users to look outward at influencers instead of inward at their expertise. Revisit only if Ideas-tab behavioral data shows users hunting for a browsable library.
2. **A top-level Templates tab.** Templates surface inside the generate flow and inside idea cards only. A nav-level template gallery elevates the most commoditized feature and trains clone-first behavior.
3. **An idea *library* destination.** Ideas come to the user (dashboard, pill, email); the Ideas tab is a queue of accepted ideas, not a place ideas are born.
4. **Publish-based streaks.** The streak action is saving an idea, not publishing. Demanding daily publishing breaks streaks for healthy 3–4×/week posters and poisons the mechanic.
5. **Trending-topic ingestion (news feeds, external trend APIs).** Tier-0 evergreen prompts are niche-*biased*, not trend-*driven*. External trend mining is a separate future initiative.

---

## The Loop (design overview)

```
TRIGGER            ACTION                REWARD                      INVESTMENT
daily email   →    open Daily 3     →    specific, personal     →    saves/ratings train feed;
(idea inside)      (or pill, any-        idea in your voice          facts auto-extracted →
                   where in app)         1 tap → draft               vault grows → better ideas
```

Surfaces, in ship order:

1. **Today's 3** — dashboard idea cards (born here)
2. **Global ✨ Ideas pill** — same cards, any screen, mid-session
3. **Daily email** — card #1 verbatim, deep-link to pre-filled draft
4. **Ideas tab** — the queue where saved ideas wait
5. **Weekly Content Plan** — later phase; Daily 3 become "today's slot in your plan"

---

## The Idea Supply Ladder

Ideas are sourced from the richest tier available. The experience is identical at every tier — three cards, written hooks, one tap — only specificity degrades. **There is no empty state.** Each card declares its provenance.

| Tier | Source | Available | Example provenance line |
|---|---|---|---|
| **T3** | Vault documents (`vault_ideas`, chunks, RAG) | vault has content | "From your Meridian case study" |
| **T2** | Behavioral exhaust — published posts + performance tags, stalled drafts, clarification-flow answers | after ~1 week of any use | "Your framework post was your best performer this month — here's the sequel" |
| **T1** | Onboarding exhaust — `business_positioning`, `content_pillars`, LinkedIn headline/About, `website_articles_text`, Voice DNA Q&A | every user, minute one | "Based on your positioning around pricing transformation" |
| **T0** | Niche-biased evergreen prompts (floor) — ~40 consultant-post scaffolds biased by niche + pillars | always | "A question every consultant can answer" |

Existing machinery to build on: `GET /api/vault/suggest-topics` (type-aware, pillar-fed), `hook_preview` generation (Haiku, fire-and-forget), mix recommendation (`GET /api/posts/mix-recommendation`), performance tags + Content Intelligence, two-stage generation pipeline.

---

## Extraction-First Vault (inverting the dependency)

The vault must fill itself as a byproduct of daily use. Deposit-first ("upload documents, then get value") is homework consultants won't do.

1. **Auto-memories from generation sessions.** Every raw idea typed and every clarification answer contains facts — client situations, numbers, opinions. Extract and save as vault entries with a visible confirmation ("ScoutHook remembered: you cut onboarding time 40% for a fintech client"). Extends the existing per-save voice-refinement extraction pipeline from *style* to *facts*.
2. **The daily question card.** When supply is thin, one of the three cards becomes a question ("What did a client push back on this week?"). A 30-second typed or spoken answer (mic already built) becomes both today's post seed and a permanent vault entry. Doubles as the ideal streak action.
3. **Frictionless capture.** URL drop (roadmap #11), voice notes; Chrome extension later (roadmap #10).

**UI language reframe:** the vault is presented as *ScoutHook's memory of you* — a relationship that grows on its own — not a filing cabinet to maintain. The user is allowed to forget it; the system never does.

---

## Information Architecture Decisions

| Surface | Role | Decision |
|---|---|---|
| Dashboard | Ideas are **born** here | Today's 3 replaces the "What's on your mind?" hero as the primary zone |
| ✨ Pill (global, sidebar/topbar) | Ideas **anywhere**, mid-session | Opens slide-over with the same cards; badge/pulse when fresh; demonstrated in onboarding to beat banner blindness |
| **Ideas tab** | Ideas **wait** here (queue, not library) | Saved cards, pending daily-question answers, expiring items; count badge in sidebar. Undoes the current `ideas.html` → `vault.html` redirect |
| Vault | Pure memory / source material | No idea surfaces on this page; increasingly self-filling |
| Templates | Inside generate flow only | Starting-point scaffolds that get vault-grounded; never top-level nav, never fill-in-the-blank text |

Idea lifecycle: **born** (dashboard/pill) → **wait** (Ideas tab) → **die into drafts** (Write this →).

---

## User Stories

**The stuck consultant (primary)**
- As a consultant with nothing in mind, I want to log in and see three specific post ideas written as first lines, so I can pick one instead of inventing one.
- As a consultant reviewing an idea, I want to see where it came from (my case study, my past post's performance), so I trust it's mine and not generic AI filler.
- As a consultant who likes a card, I want one tap to land in a pre-filled draft in my voice, so there is zero re-entry of context.
- As a consultant who dislikes a card, I want to dismiss or shuffle it, and never see that angle again.

**The empty-vault new user**
- As a brand-new user with no uploads, I want ideas from day one (from my positioning, About, website), so the product works before I've done any homework.
- As a new user, I want answering one small daily question to count as progress, so building my vault never feels like a chore.

**The habitual user**
- As a returning user, I want a daily email containing an actual hook that deep-links into a draft, so acting takes under 3 minutes from my inbox.
- As a consistent user, I want my streak preserved by saving one idea (not publishing), so a no-post day doesn't destroy my momentum.
- As a user mid-session on any page, I want the ideas pill within reach, so getting unstuck never requires navigation.

**Edge cases**
- As a user who ignores the Daily 3 for a week, I want fresh (never repeated-dismissed) ideas each day, so the card doesn't become banner blindness.
- As a user whose queue is full, I want the oldest saved ideas surfaced before new ones pile up, so the queue stays a working list, not a graveyard.

---

## Requirements

### Phase 1 — Today's 3 + supply ladder + extraction (P0)

**R1. Daily idea cards on dashboard**
- [ ] Dashboard renders exactly 3 idea cards for every user, every day, above existing zones
- [ ] Each card shows: a written hook (an actual first line, ≤2 sentences — not a topic label), a provenance line, and a post-type chip
- [ ] Primary action **Write this →** opens the generator with type + idea context pre-filled, skipping the intent grid
- [ ] Secondary actions: **Save** (→ Ideas queue), **Not for me** (dismiss + never re-serve that angle)
- [ ] Cards refresh daily; unserved cards expire (visible "new ideas tomorrow" affordance)
- Given a user with an empty vault, when they load the dashboard, then 3 cards render from T1/T0 sources with honest provenance lines.

**R2. Supply ladder resolver**
- [ ] Idea generation walks T3 → T2 → T1 → T0 and fills the 3 slots from the richest tiers available
- [ ] Mix recommendation biases card post-types toward the user's under-indexed type
- [ ] Dedup memory: dismissed angles and previously served ideas are never repeated (per-user served/dismissed log)
- [ ] Card provenance stored with the idea and persisted to `generated_posts.source` when a post results

**R3. Fact extraction (auto-memories)**
- [ ] Raw ideas and clarification answers are mined for reusable facts post-generation (async, fire-and-forget)
- [ ] Extracted facts saved as vault entries flagged `source='auto_extracted'`, feeding T3 supply
- [ ] User sees a lightweight "ScoutHook remembered…" confirmation; entries are reviewable/deletable in the vault

**R4. Daily question card**
- [ ] When T3+T2 can't fill 3 quality slots, one card becomes a niche-biased question
- [ ] Answer (text or mic) → immediate post seed + permanent vault entry
- [ ] Answering counts as the day's streak action (once R6 ships)

**R5. North-star instrumentation**
- [ ] Every generated post records origin: `served_idea` (card/pill/email/queue) vs `typed_idea`
- [ ] Card-level funnel events: served → viewed → clicked/saved/dismissed → generated → published

### Phase 2 — Pill + email + streak (P0 for retention)

**R6. Save-to-queue streak**
- [ ] Streak increments on: saving an idea, answering the daily question, or generating a post — whichever comes first that day
- [ ] Professional framing ("Consistency: 3 of 4 planned posts this week"), no fire-emoji gamification
- [ ] Streak visible on dashboard; weekly recap includes it

**R7. Global ✨ Ideas pill**
- [ ] Present on every app page; opens a slide-over with the current Daily 3 + shuffle
- [ ] Badge/pulse when unseen fresh ideas exist; onboarding demonstrates it once
- [ ] Ideas paired with the user's own proof (provenance / own post performance) — never third-party viral posts

**R8. Daily idea email**
- [ ] Contains card #1's actual hook verbatim + one-tap deep link into a pre-filled draft
- [ ] Cadence user-controlled (daily / weekdays / off); sent via existing Resend pipeline
- [ ] Suppressed on days the user already acted (no nagging past the streak action)

**R9. Ideas tab (queue)**
- [ ] Sidebar item with count badge; replaces `ideas.html` → `vault.html` redirect
- [ ] Contains saved cards, pending daily-question answers, captured URLs/voice notes
- [ ] Items age visibly; oldest surface first; one-tap **Write this →** from any item

### Phase 3 — Weekly Content Plan (P1)

**R10.** Monday plan proposal from cadence + vault + mix target; each slot pre-seeded with an idea + hook; approve/swap; Daily 3 become "today's slot in your plan"; graceful re-planning when slots are missed (no guilt artifacts). *(Roadmap #6 — detailed spec to follow when scoped.)*

### Future considerations (P2)

- Templates as in-flow starting points on the generate page (evolution of the intent grid; scaffolds only, always vault-grounded)
- Chrome extension capture → Ideas queue (roadmap #10)
- Browsable idea library — **only if** queue-tab data shows origination-seeking behavior
- Trend-aware T0 (external niche trend ingestion)

---

## Success Metrics

**North star:** % of generated posts starting from a served idea. Target ≥40% at 60 days; stretch 60%.

Leading (weekly review):
- Daily 3 engagement: % of dashboard sessions with a card interaction (target ≥50%)
- Card → generation conversion (target ≥25% of clicked cards)
- Dismiss rate (health check: sustained >60% dismissals = idea quality problem)
- Email CTR to draft (target ≥15%)
- Daily question answer rate when served (target ≥30%)

Lagging (monthly review):
- Posts/week per active user (+25% at 90 days)
- DAU/WAU ratio (baseline pre-launch, expect lift post Phase 2)
- Users with ≥5 auto-extracted vault entries at day 30 (≥50%)
- 7-day idea-action streak attainment (Duolingo threshold — the retention cliff to push users over)
- Free→Pro conversion delta for served-idea users vs typed-idea users

---

## Open Questions

- **[Product]** Card expiry: hard daily expiry vs. 48h grace? (Scarcity drives return, but punishing a missed day may feel hostile. Lean: expire, but auto-save the best card to the queue once per week.)
- ~~**[Engineering]** Daily generation: pre-compute nightly vs. on-first-load?~~ **RESOLVED (2026-07-11, sprint planning):** generate on first dashboard load + cache in `idea_cards` for the day. Nightly precompute deferred to Phase 2 when the daily email needs it. Avoids token spend on inactive users.
- **[Engineering]** Fact-extraction precision bar — auto-save with review, or hold for confirmation? Wrong "memories" damage trust faster than missing ones. (Non-blocking; start conservative.)
- ~~**[Product]** Does Today's 3 replace the dashboard hero banner or sit above it?~~ **RESOLVED (2026-07-11, sprint planning):** replace the hero. "What's on your mind?" is the question the user can't answer — that's the problem this feature exists to remove.
- **[Design]** Streak visual language for a professional tool — needs exploration before Phase 2.
- **[Data]** Pre-launch baselines needed: posts/week distribution, DAU/WAU, current suggest-topics usage rate.

---

## Timeline & Phasing

No hard external deadlines. Sequencing logic: each phase makes the next one work — A gives E something worth triggering toward; the ladder + extraction make A work for empty-vault users from day one.

| Phase | Scope | Dependency |
|---|---|---|
| 1 | Today's 3 + ladder + extraction + instrumentation (R1–R5) | Mostly re-surfacing existing machinery (`suggest-topics`, `hook_preview`, pillars, mix rec) |
| 2 | Streak + pill + email + Ideas tab (R6–R9) | Phase 1 idea supply live; Resend pipeline exists |
| 3 | Weekly Content Plan (R10) | Phase 1–2 data on which idea types convert |

Competitive urgency: Postiv's weekly agent plan and FeedBoss's daily feed already own this narrative in Camp 3 / adjacent tools; Supergrow ships fast (see `competitive-intel-2026.md` Strategic Watch List). The vault-grounded version is defensible — but only once it's shipped and visible.

---

## Decision Log (from design exploration, 2026-07-11)

1. Core principle: product supplies ideas; user reacts — never origination-first
2. Daily 3 on dashboard with written hooks + provenance + one-tap draft
3. Global ideas pill (Supergrow's pattern, user's-own-proof fuel)
4. Daily email with the idea inside it, deep-linking to a pre-filled draft
5. Streak preserved by tiny action (save an idea), not publishing
6. Weekly plan as the maturity layer (Phase 3)
7. 4-tier supply ladder; no empty state ever; cards declare provenance
8. Extraction-first vault: auto-memories + daily question + frictionless capture
9. Vault reframed as "ScoutHook's memory of you"
10. Ideas tab = queue (born on dashboard/pill, wait in tab, die into drafts)
11. Templates in generate flow only; never top-level nav
12. Viral swipe library skipped (see Non-Goals)
13. North star: served-idea share of generated posts

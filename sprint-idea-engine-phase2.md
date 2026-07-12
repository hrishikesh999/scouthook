# Sprint — Idea Engine Phase 2: "The Retention Layer"

*Planned: 2026-07-11 · Built: 2026-07-12 · Spec: `idea-engine-spec-2026.md` (R6–R9)*

**Status: P0 + P1 (tasks 9–14) SHIPPED 2026-07-12.** Task 15 (weekly plan seed) deferred per cut order — it's Phase 3 prep and there is no weekly-plan surface to seed yet. Migration 072 applied.

**Sprint Goal:** Convert the Daily 3 from a feature into a habit loop. Streak visibility + global Ideas pill + saved queue + nightly pre-compute establish a multi-touch funnel: daily idea → save or answer → streak increments → queue fills → weekly plan seeds.

**Dependencies:** Phase 1 deployed + 2-3 day dogfood pass complete. Dismiss rate data from `/admin/idea-engine-report` informs prompt tuning if needed (gate: do not build retention layer around poor ideas).

## Backlog

| Pri | # | Task | Est | Notes |
|---|---|---|---|---|
| P0 | 9 | Ideas tab (saved queue + history) | 1.5d | Sidebar entry; saved idea cards + answered questions; oldest first; one-tap Write this → prefill |
| P0 | 10 | Streak counter (save/answer/generate action threshold) | 1d | Professional framing: "Consistency: X of Y planned posts" vs. Duolingo gamify; daily reset; visible on dashboard; loss-aversion retention |
| P0 | 11 | Global Ideas pill (✨ button on every app page) | 1.5d | Slide-over drawer with Daily 3 + shuffle; fresh count badge; user's own proof only (no third-party viral posts) |
| P0 | 12 | Nightly idea pre-compute (cards cached at 6am for email) | 1.5d | Scheduled cron; cache idea_cards without the served_on timestamp collision; warms Sonnet T2/T1 calls so email has instant data; replaces Phase 1's on-load latency with delivery speed |
| P0 | 13 | Daily ideas email (Resend) | 1.5d | Card #1's hook in subject; card #1's preview in body (visual + 1-tap deep link); user cadence control (daily/3x/week/off); suppress on days user already acted; tied to nightly pre-compute |
| P1 | 14 | Cadence & personalization settings | 1d | Email frequency toggle (daily/3x/weekly/off); time-of-day preference; "your weekly idea allocation" messaging |
| P2 | 15 | Weekly content plan seed (Phase 3 prep) | 1d | Pre-populate 5-post Monday plan with Today's 3; reserve slots for user's own ideas; tie idea card status to slot fill |

P0 = 6d at ~75% of 8 working days. Cut order if slipping: P2 → P1 → skip 12 (pre-compute deferrable to Phase 2.5 if email is sync-generated).

## Sequencing rationale

**Why start with Ideas tab (R9)?**
- Phase 1 has no visible home for "saved" cards — they go into the DB but the user has no surface to act on them.
- The streak and email both rely on a "queue" or "my saved ideas" surface; without it, save/answer/dismiss are pure analytics, not behavior.
- Building it first unblocks streak (it increments on save) and email (fallback destination).

**Why streak before pill?**
- Streak is a small, self-contained UI change (dashboard counter + save/answer/generate hooks to increment).
- Pill is larger (repeatable drawer component on ~8 pages) but reuses all Daily 3 logic.
- Streak ships first so users see the retention signal early; pill amplifies it by making ideas always available.

**Why pre-compute last (or defer)?**
- Email can ship with sync-generated cards (Resend doesn't care if Haiku is called mid-send; the 2-3s latency is tolerable for the first 10 users).
- Pre-compute is a scaling optimization, not a shipping blocker. Deferring lets us ship email sooner and add it to Phase 2.5 if needed.

## Decisions

- **Streak definition**: Increment on any one of save card, answer question, generate post (not just "share to LinkedIn"). The bar is "contributed to your content pipeline," not "published."
- **Pill scope**: Reuses Daily 3 exact card data (hook, type, provenance, idea_card_id); no "related ideas" or algorithmic shuffles — just same 3 + reshuffle via button. Keeps the pill in lockstep with dashboard.
- **Email destination on day-1 cadence**: If user hasn't set cadence, default to weekly (lower volume than daily, less likely to unsubscribe). User can change in settings.
- **No email/pill for shared-vault spaces yet** (Phase 3 multi-tenant ideas). Phase 2 is single-user ideas only; multi-user vault is post-Phase2.

## Risks

| Risk | Mitigation |
|---|---|
| Streak visibility creates anxiety (over-reporting) | User research during dogfood; frame as "consistency," not "streaks" (no day-counting, no fire emoji) |
| Email adoption low if cadence wrong | Default to weekly (lower friction); AB test in Phase 2.5 if needed |
| Nightly cron fails, email goes out with stale cards | Fallback: email cron calls getDailyCards() fresh if cache miss; monitors alert on staleness |
| Pill abuse: users leave drawer open, idea feed goes stale | Shuffle button (one fresh rotation/drawer-open); close on navigate; re-open re-fetches if >1hr old |

## Definition of Done

- [x] Ideas tab: sidebar entry with badge (queue count); /ideas route shows saved cards + recent questions; oldest-first sort; one-tap Write this → prefill chain works end-to-end. Bonus: "Ask me a question" mints an on-demand question card (`POST /api/ideas/question`).
- [x] Streak: increments on save/answer/generate; lazy daily reset (midnight UTC, no cron); visible on dashboard as quiet "Consistency: N days" chip (hidden at 0 — no pressure); `streak_incremented` event logged once per user per day
- [x] Pill: ✨ button on every app page (all sidebar pages; editor deliberately excluded); `<dialog>` slide-over with Daily 3 + shuffle (rotates same 3, no new fetch); 1h sessionStorage cache busted on card actions; closes on SPA navigate; fresh-count badge
- [x] Email: Resend integration (`daily-ideas` template); subject = card #1 hook (90-char cap); body = card preview + prefilled write deep link; cadence daily/3x/weekly/off (NULL = weekly default); suppressed on action-days (idea event or generated post in last 24h); 7–10am local-time send window, email_log dedup per local date
- [x] Pre-compute: in-process tick every 30 min, fires once per UTC day ≥ 6am UTC (platform_settings guard); warms idea_cards for users active in last 14 days; email cron falls back to sync getDailyCards() on cache miss
- [x] Admin report extended: queue funnel (in_queue_now / archived / queue→write), daily-ideas email sends + recipients, active-streak stats, cohort view by join month; events breakdown now includes idea_email_sent / idea_question_minted / streak_incremented

## As-built notes (deltas from plan)

- Crons are **in-process** (`setInterval` in server.js, staggered offsets) matching every other ScoutHook cron — not an external Vercel/Railway cron as the implementation notes suggested.
- Streak columns live on `user_profiles` (`streak_count`, `streak_last_date`); reset is **lazy on read** (streak reports 0 when last action < yesterday) so no daily reset cron exists.
- Email prefs UI lives on **account.html#email-prefs** (user-scoped, like the rest of that page), not settings.html; API is `GET/PUT /api/email-preferences`.
- Card rendering extracted to shared `public/js/idea-cards.js` (dashboard + pill + queue all use it); `/api/ideas/today` now flows through cachedFetch (1h TTL) shared by dashboard and pill, busted on any card action.
- Queue removal uses a new `archived` card status (distinct from `dismissed`, which means "never re-serve").

## Implementation notes

- **Ideas tab**: Reuse the idea card grid from dashboard; add a "New question" button; saved cards stay visible until dismissed from queue (soft-delete, archived status).
- **Streak**: One new column in `user_profiles.streak_count` + `streak_reset_at`. Hooks in `/api/ideas/:id/save`, `/api/ideas/:id/answer`, `/api/generate` POST. Daily cron resets at UTC midnight.
- **Pill**: Extract Daily 3 render logic into a shared component; use `<dialog>` for drawer (close-on-escape, close-on-navigate via router hook). Store drawer state in sessionStorage (fresh for 1hr, then refetch).
- **Email**: Resend template with card #1 data + user-facing cadence management at `/settings/email-preferences`. Cron sends at 7am user's local timezone (derive from profile). Suppress days when `platform_events` has 'idea_generated' or 'post_shared' within last 24h for this user.
- **Pre-compute cron**: `node jobs/nightly-idea-cache.js` scheduled via a third-party cron (Vercel cron, Railway background jobs, or AWS Lambda). Cache TTL = 18h (covers 6am through midnight). Fallback: if cache miss at email-send time, call getDailyCards() fresh.

## Open Questions

- Should streak reset **daily** (same time for all users) or **rolling** (24h from last action)? → Recommend daily (midnight UTC) for simplicity and cohort alignment (weekly plan sessions are Mondays).
- Email send time: **7am user's local timezone** or **7am UTC + offset from profile**? → If no timezone set, default to America/New_York; user can override in settings.
- Pill shuffle: **one fresh rotation per open**, or **refresh on every shuffle tap**? → Recommend one per open (low friction, predictable); add "Get new ideas" → navigates to dashboard if user wants more.
- Should archived/dismissed cards reappear in queue after 30 days, or stay gone forever? → Recommend stay gone (user explicitly rejected); keep a "trash" view for recovery if needed.


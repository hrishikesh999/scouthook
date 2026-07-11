# Sprint — Idea Engine Phase 2: "The Retention Layer"

*Planned: 2026-07-11 · Dates: TBD (post Phase 1 dogfood) · Spec: `idea-engine-spec-2026.md` (R6–R9)*

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

- [ ] Ideas tab: sidebar entry with badge (unseen count); /ideas route shows saved cards + recent questions; oldest-first sort; one-tap Write this → prefill chain works end-to-end
- [ ] Streak: increments on save/answer/generate; resets daily; visible on dashboard (professional framing); event logging for north-star
- [ ] Pill: ✨ button on every app page (dashboard, drafts, vault, generate, settings); slide-over drawer with Daily 3 + shuffle; fresh/stale state; close on navigate
- [ ] Email: Resend integration; subject = card #1 hook; body = card preview + deep link; user cadence settings (daily/weekly/off); suppressed on action-days
- [ ] Pre-compute (if not deferred): cron at 6am UTC; caches idea_cards for all active users; email uses cache, not sync-generated
- [ ] Admin report extended: idea funnel now includes "saved → queue", "queue → write", "question → email"; cohort view by join date

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


# Sprint — Idea Engine Phase 1: "Today's 3"

*Planned: 2026-07-11 · Dates: 2026-07-13 → 2026-07-24 · Spec: `idea-engine-spec-2026.md` (R1–R5)*

**Sprint Goal:** A user who logs in with nothing in mind reaches a generated draft from a served idea in under 60 seconds — at any vault state — and we can measure exactly how often that happens.

## Backlog

| Pri | # | Task | Est |
|---|---|---|---|
| P0 | 1 | Migration 071 — `idea_cards` table + `generated_posts.idea_card_id` | 0.5d |
| P0 | 2 | `services/ideaEngine.js` — supply ladder resolver (T3→T0, mix-rec bias, dedup, on-load + daily cache) | 2d |
| P0 | 3 | T0 evergreen prompt bank (~40 consultant scaffolds, niche/pillar-interpolated) | 0.5d |
| P0 | 4 | `routes/ideas.js` — today / save / dismiss / answer | 0.5d |
| P0 | 5 | Dashboard Today's 3 UI — replaces hero banner | 1.5d |
| P0 | 6 | Generate-page handoff (`?idea_card=`) → prefill, skip grid, origin stamped on post | 0.5d |
| P0 | 7 | Instrumentation — funnel events + north-star admin report | 0.5d |
| P0 | 8 | Fact extraction service (auto-memories, conservative threshold) | 1.5d |
| P1 | 9 | Daily question card (thin-supply → question → vault entry + seed) ✅ 2026-07-11 | 1d |
| P2 | 10 | Dogfood tuning pass (3 days self-use → prompt/threshold tuning) | 0.5d |

P0 = 7.5d at ~75% of 10 working days. Cut order if slipping: #10 → #9 (T0/T1 guarantee no dead end without it).

## Decisions locked at planning
- Card generation is **on-first-load + daily cache**, not nightly cron (nightly deferred to Phase 2 email)
- Today's 3 **replaces** the dashboard hero banner
- Daily question card demoted to P1 (accelerator, not launch dependency)

## Risks
| Risk | Mitigation |
|---|---|
| Idea quality below "unrejectable" bar | Dogfood before announcing; dismiss-rate event from day one |
| Fact extraction saves wrong memories | High-confidence only, ≤3/session, visible + deletable |
| Token cost | On-load caching = only active users cost anything |
| Migration 036 pending in prod | 071 follows existing `vault_ideas` tenant pattern; no 036 dependency |

## Definition of Done
- [x] P0 code complete (2026-07-11 — all 8 tasks); migration 071 applied to prod ⚠️ *(local `.env` points at the prod Neon DB — migration is additive-only, no deployed code touches it yet)*
- [x] Empty-vault AND full-vault tenants both get 3 cards with honest provenance *(service-level test: full-vault → T3+T0; empty tenant → 3×T0; save/dismiss + cross-tenant guard verified; test artifacts cleaned from DB)*
- [ ] End-to-end in-browser verified: login → card → Write this → post row carries `idea_card_id` *(pending — requires a session + Anthropic key; local env has no key, so T1/T2 LLM cards and fact extraction are prod-only paths)*
- [x] Admin report endpoint live (`GET /admin/idea-engine-report`)
- [x] Spec open questions resolved this sprint marked as decided

## Implementation notes (2026-07-11)
- `services/ideaEngine.js` — ladder resolver; T3 capped at 2/day; one shared Sonnet call for T2+T1; T0 local interpolation. Origin stamping via `res.json` interception + the shared `sseWrite('done')` hook (streaming path bypasses res.json).
- `services/factExtraction.js` — auto-memories land in `vault_ideas` with `source='auto_extracted'` + a Haiku-written `hook_preview`, so they surface in the existing vault UI AND feed T3 automatically. Guard: card-originated input is only mined if the user edited it (never "remember" AI-drafted facts). Runs pre-RAG so it only sees user-typed text.
- "ScoutHook remembered…" toast deferred to the dogfood pass (extraction is async; post-generation navigation makes same-page toast timing unreliable). Memories are visible/deletable in the vault today.
- Dashboard hero kept in markup as a fallback, shown only if `/api/ideas/today` fails.
- `?idea_card=` handoff reuses the existing `?type=&idea=&vault_idea_id=` prefill machinery in generate.js; `lead_magnet` cards map to the `lead_gen` guided flow.
- **Task #9 (daily question card) shipped same day.** 16-question bank in `evergreenIdeas.js` (recent-specific-experience prompts, niche-interpolated, day-rotated, 60-day slug dedup). Trigger: <2 T3 cards → last slot becomes the question. `POST /api/ideas/:id/answer` stores the answer verbatim in `vault_ideas` (`source='daily_question'`) with a fire-and-forget Haiku `hook_preview` so it qualifies for T3 tomorrow; card → `answered`; client redirects to the generator with Q+A prefilled (origin stamped as usual). Dashboard: inline answer form with mic (reuses `initVoiceInput`), "Not today" dismiss, answered-state render. factExtraction dedup now also excludes daily-question memories. Self-balancing: answering un-thins tomorrow's supply, so questions naturally stop appearing.

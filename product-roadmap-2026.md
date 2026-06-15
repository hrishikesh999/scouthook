# ScoutHook — Product Roadmap 2026

*Last updated: 2026-06-15. Review at the start of each sprint.*

---

## Product Vision

ScoutHook turns documented expertise into LinkedIn posts that generate leads. The core motion: upload documents → extract insights → generate posts grounded in specific facts → publish → capture warm leads from comments.

**Strategic position:** Camp 2.5 — beyond voice-first generation into a full content-to-pipeline system. The only tool that preserves verbatim facts from source documents (not just voice or style) and closes the loop from content to client pipeline.

---

## Tech Stack (current)

- **Backend:** Node.js/Express, Neon PostgreSQL, BullMQ + Redis
- **AI:** Anthropic Claude — Haiku for classification/coaching, Sonnet for generation (extended thinking mode active)
- **Frontend:** Vanilla JS, no framework; SPA-lite navigation with sidebar caching
- **LinkedIn:** OAuth 2.0, UGC posts API (v202603), documents API (PDF carousel), feedshare image API
- **Email:** Resend (transactional)
- **Billing:** Paddle — Free (7-day Pro trial) → Pro ($29/mo)
- **List management:** Mailerlite

---

## Pricing (current — as of 2026-06-13)

| Plan | Price | Key limits |
|---|---|---|
| Free | $0 (7-day Pro trial on signup) | 10 generations/month, no scheduling, no analytics |
| Pro | $29/mo | Unlimited generations, scheduling, carousels, analytics |

> **Note:** Solo plan ($19/mo) was removed on 2026-06-09. All users are now Free or Pro. Founding price IDs still map to Pro in `getUserPlan()`.

---

## Shipped Features — Full History

### Sprint 1 — 2026-05-06

- **Hook archetype injection** — `selectHook()` runs in parallel with substance check; `archetype_used` persisted (migration 018)
- **Post performance tagging** — 🔥/👍/👎 on published posts; dashboard "Rate your posts" nudge + Content Intelligence card (migration 018)
- **Viral tension pre-check** — `assessInputQuality()` blocks generation (HTTP 422) when input lacks specific outcome AND surprising angle; amber warning with bypass

---

### Sprint 2 — Voice DNA Architecture — 2026-05-19

- **`services/voiceExtraction.js`** — `extractVoiceDNAFromQA`, `buildVoiceDNABlock`, `calculateCompletionPct`, `captureVoiceRefinement`
- **Migration 023** — 15 Voice DNA columns on `user_profiles`; `source` on `generated_posts`
- **Onboarding redesign** — 4-step PLG flow; 3 interview questions with context badges; processing screen; post reveal with quality/hook/voice badges, alt-hook chips, LinkedIn nudge
- **Voice Profile Wizard** — 5-stage settings wizard (expanded to 7 in post-Sprint-2 polish)
- **Dashboard voice profile card** — until completion ≥ 80%

---

### Post-Sprint-2 Polish — 2026-05-20

- **LinkedIn OAuth → auto voice profile** — `extractVoiceDNAFromLinkedIn()` fires after OAuth; headline → niche/audience/positioning; source-aware merge rules
- **`business_positioning` pre-population** from 3 sources (Q&A, website, LinkedIn); `POST /api/profile/generate-positioning` endpoint
- **Settings wizard** expanded to 7 stages; Stage 1 field order restructured (niche+audience first, positioning with inline "✦ Generate")
- **Topic starters on generate page** — 3 AI topic cards when idea textarea is empty; `GET /api/vault/suggest-topics`

---

### Sprint 3 — Post Generation Revamp — 2026-05-21

- **Post type system** — Reach / Trust / Convert / Lead Magnet; `post_type` on `generated_posts` (migration 024)
- **Mix recommendation** — `GET /api/posts/mix-recommendation` shows under-indexed type; ✦ marker on recommended chip
- **Retro tagger** — label legacy posts with type via `PATCH /api/posts/:id/type`
- **Generate page rebuild** — single-pane state machine; type chip → auto-advance → input pane
- **Type-aware topic starters** — `GET /api/vault/suggest-topics?post_type=` with per-type bias
- **Vault picker with hook preview** — `hook_preview TEXT` on `vault_ideas` (migration 024); Haiku generates ≤12-word hook fire-and-forget
- **Lead magnet 4-step chat thread** — conversational form; 4 templates: research_drop, system_giveaway, transformation, breaking_news
- **Convert CTA intent row** — appears after 80 chars for Convert posts
- **Processing screen** — 4-step staggered reveal (800ms intervals)
- **Editor signals** — reveal intro sentence; hook explanation badge; post type badge; quality verdict as text (migration 024); `lead_magnet_template` + `lead_magnet_inputs` persisted (migration 025)
- **Template picker for lead magnets** — "Change →" opens 4-option picker; regenerates on select

---

### Phases 1–7 Quality Initiative — 2026-05-26

- **Phase 1 — Vault-First Onboarding** — new Step 3 "Upload your best work" between Q&A and first post; PDF/DOCX/TXT/URL; skippable; quality-lift banner for users with empty vault
- **Phase 2 — Voice Signal from Real Writing** — website crawls up to 3 blog pages; `website_articles_text` (migration 027); `writing_sample_phrases` (migration 026); writing sample paste step in onboarding; Voice extraction model → Sonnet; extracts sentence rhythm, vocabulary tier, opening move, argument structure, what user never says
- **Phase 3 — Smarter Input** — `input_examples` (migration 028); 3-4 niche-specific placeholder examples via Haiku; rotating placeholders; "Help me find my story →" micro-interview panel; niche-aware specificity nudge; `POST /api/profile/generate-input-examples`
- **Phase 4 — Two-Stage Generation** — Haiku Stage 1 (tension/arc/archetype/hook_draft) → Sonnet Stage 2 (writes using blueprint); processing screen shows "Found the tension: [arc]" between stages
- **Phase 5 — Feedback Loop** — `ai_content` (migration 029) preserves original AI output; auto-save drafts (debounced 2s PATCH); multi-dimensional change detection (hook/vocabulary/length/general); voice rules extracted per save; "Voice is learning →" indicator shows 3 most recent refinements
- **Phase 6 — Multi-Dimensional Substance Check** — 4 dimensions (specific/tension/relevance/novelty); tiered response: 4/4 generate, 3/4 generate+hint, 2/4 coaching note, 1/4 full warning; "Improve my input →" opens micro-interview
- **Phase 7 — Personalized Hook Strategy** — `content_pillars` + `user_archetype_preference` (migration 030); content pillars generated at onboarding completion; archetype preference tracks publish count; `selectHook()` injects USER SIGNATURE STYLE block; archetype coaching panel in settings

---

### Workspaces + Profiles + Multi-LinkedIn + Email Auth (Sprints 4–5) — 2026-06-04

**Foundation (migration 036 — not yet applied to prod):**
- New tables: `workspaces`, `workspace_members`, `workspace_invites`, `profiles`, `linkedin_connections`; drops `linkedin_tokens`

**Plan enforcement:**
- `lib/planFeatures.js` — PLAN_FEATURES, PLAN_LIMITS, getWorkspaceLimit, planHasFeature, rankPlan
- `middleware/requireFeature.js` — per-feature gating; vault writes (Solo+), scheduling (Solo+), carousel (Pro), team_members (Pro), multiple_linkedin_accounts (Pro)
- `requireWorkspaceActive` middleware applied to generate/vault/linkedin routes

**Billing:**
- `routes/billing.js` — GET /subscription with workspace stats + trial_ends_at; POST /upgrade; POST /add-workspace
- `lib/workspaceUtils.js` — enforceWorkspaceLimitGrace + clearWorkspaceGracePeriods (cancels pending posts)
- `workers/workspacePurge.js` + daily cron (purges workspaces past purge_at)
- Trial expiry cron — sends 3-days-before warning email
- Email templates: `trial-expiry.html`, `workspace-grace-period.html`
- Settings → Billing tab: workspace usage bar, trial countdown, plan badge, upgrade CTA
- Trial banner in `account-bar.js` (dismissible, shows days remaining)

**Upgrade modal:**
- `public/js/pricing-modal.js` rewritten — Free/Solo/Pro 3-tier comparison; `open({ feature, requiredPlan })`; per-card checkout via POST /api/billing/upgrade; context banner for 403 `feature_not_available` responses

**Email auth:**
- `routes/email-auth.js` — signup, verify-email, login, forgot-password, reset-password, resend-verification (IP rate limiters)
- bcryptjs + passport-local
- Public pages: `signup.html`, `check-email.html`, `reset-password.html`, `forgot-password.html`
- `login.html` — email/password form + "or" divider + forgot password
- `workspace-setup.html` — workspace name + LinkedIn connect + skip

**Admin:**
- `routes/admin.js` — workspace-aware diagnostics, GET /admin/workspaces/:id, POST /admin/workspaces/:id/clear-grace, user lookup via auth_providers

---

### Generate Page Redesign — 2026-05-27 → 2026-06-04

- Kleo-inspired textarea-first layout (May 27)
- 3-card intent grid chips (May 27)
- Starting point pills — 3 quick-start options (June 4)
- Idea engine rebuilt — 3 rich ideas with brief expansion via Haiku; client-side filtering; no re-fetch on filter change (June 1-3)
- 'Writing as' profile selector below input card (June 4)
- Substance gate replaced with conversational clarification flow (May 27)
- Lead magnet generation path removed — simplified to core paths (June 1)

---

### Content Vault UX — 2026-05-27 → 2026-06-03

- Vault UX overhaul — mining visibility + ideas slide-over panel (May 27)
- Content pillars fed into suggest-topics context (May 27)
- Mix recommendation factored into Get ideas panel (May 27)
- Suggest-topics upgraded from Haiku to Sonnet (May 27)
- "Idea Vault" renamed → "Content Vault" (June 3)
- Ideas library seeded with 50 curated LinkedIn posts as examples (June 3)

---

### Editor Overhaul — 2026-05-30 → 2026-06-13

- Complete editor redesign — centered post, meta panel at top, autosave in tab bar (May 30)
- Quality gate slim-down, phrase highlights, HOOK_TOO_SHORT check added (May 28, May 30)
- Post-publish success sheet (May 26)
- Post Improver chat panel — persistent across tab switches, full-width chat (June 4-5)
- Version history bar — persists to localStorage so it survives page navigation (June 5)
- Formatting toolbar — bold, italic, bullets, emoji strip (June 5)
- SSE streaming for real-time generation output (May 28)
- contenteditable → textarea + backdrop overlay (June 13) — resolves auto-height and undo issues
- Undo button in formatting toolbar (June 13)
- Auto-apply improvements after Post Improver suggestions
- Single Enter for new paragraphs
- Normalize triple+ newlines in legacy posts (June 13)
- Resolved all 10 UX issues from comprehensive editor review (June 12)

---

### Scheduling Modal UX — 2026-06-05

- LinkedIn account display in modal
- Fix Publish Now reliability
- Better error states and feedback

---

### Generation Quality Pipeline — 2026-05-28 → 2026-06-15

- Extended thinking mode + Sonnet creative judgment released from generation constraints (May 28, May 30)
- Prompting excellence sprint — archetype refactor, body structure mandate, example library of 50 curated posts (May 30)
- Archetype-driven length targets + narrative depth mandate (May 27)
- Token-efficient generation — reduced prompt size without quality loss (June 3)
- Generation speed improvements (June 3)
- Removed hookB/ctaAlternatives layer — simplified pipeline (June 10)
- Removed hookConfidence tracking — consolidated to single system prompt builder (June 10)
- Fixed vault path prompt inconsistencies + wired substance feedback (June 10)
- Fixed 8 pipeline gaps from generation audit (June 12)
- Fixed 4 onboarding/Voice DNA verification bugs (June 10)
- Leverage Claude's native strengths for top-1% post quality (June 15)

---

### Conversational Coach — 2026-06-02 → 2026-06-06

- Adaptive conversational coach for post generation — multi-turn guided interview replaces single-form input
- Voice recording input via Web Speech API — across generate, editor, and onboarding (June 6)
- getUserMedia pre-flight, permission state watch, denied feedback (June 8)
- Coach mode mic repositioned; stale text fix in clarification flow (June 6)

---

### Voice Recording — 2026-06-06

- Web Speech API across generate page, editor, and onboarding
- Mic button in coach mode
- Pre-flight getUserMedia check, permission state monitoring, denied-permission feedback

---

### LinkedIn Architecture — 2026-06-04 → 2026-06-15

- Dedicated `linkedin.html` page — removed LinkedIn from account.html + settings.html (June 4)
- Voice DNA page per LinkedIn account — full view + edit + re-extract (June 4)
- Fixed LinkedIn OAuth scope error; redesigned connections UI (June 4)
- Allow one LinkedIn account to connect across multiple ScoutHook user accounts (June 12)
- Fixed duplicate LinkedIn account bug in generate page profile selector (June 9)
- Per-profile publish selector in scheduling modal (June 15)
- Connection architecture hardening (June 15)

---

### Mobile & Navigation — 2026-06-06

- Complete mobile and tablet UX overhaul across all pages
- Hamburger drawer replacing broken mobile nav
- SPA-lite navigation — eliminate sidebar re-renders, cache API calls, smooth transitions
- Remove Free Onboarding Call button + Calendly integration from sidebar

---

### Billing & Pricing — 2026-06-04 → 2026-06-13

- 7-day app-level Pro trial for all new signups, no credit card required (June 4)
- Consolidated Pro plan: removed PADDLE_PRICE_ID_FOUNDING_1/2; single PADDLE_PRICE_ID_PRO (June 4)
- Remove Solo plan tier; reprice Pro to $27/month (June 9)
- Pro price updated to $29/month (June 13)
- Pricing modal redesign — wider, more prominent, cleaner (June 13)
- Trial upgrade box + trial strip upgrade link (June 13)
- Route trial users to Paddle checkout (not billing portal) (June 13)
- Fixed billing bugs: rate limit handling, past_due grace, force-sync plan fallback, double-trial guard (June 12)

---

### Onboarding — 2026-05-27 → 2026-06-09

- Streamlined onboarding flow + improved website voice extraction (May 27)
- Removed React app + dead generation paths (May 27)
- Complete onboarding overhaul for first-post quality + Voice DNA architecture alignment (June 9)

---

### Published Posts & Navigation — 2026-05-27

- Post detail modal replaced with dedicated `/post.html` page
- Posts tab nav bar across Drafts, Scheduled, and Published pages
- Sidebar "Drafts" renamed to "Posts"
- Settings link moved into main nav

---

### Quality Gate — 2026-05-28

- HOOK_TOO_SHORT check added to catch truncated hook edits
- Quality gate slimmed down; phrase highlights in output
- Quality score pill removed from drafts list (June 3)

---

## Database Migration History

| Migration | Contents | Status |
|---|---|---|
| 001–005 | Core tables, vault tables | Applied |
| 013 | `user_role`, `onboarding_complete` on `user_profiles` | Applied |
| 014 | `business_positioning`, `ghostwriter_prompt`, `batch_id`, `first_comment` | Applied |
| 015 | `website_url` on `user_profiles`; `first_comment*` on `scheduled_posts` | Applied |
| 017 | `first_comment` column | Applied (manual) |
| 018 | `archetype_used`, `performance_tag`, `performance_note`, `performance_tagged_at` on `generated_posts` | Applied |
| 019 | `goal` on `user_profiles` | Applied |
| 021 | `support_requests` table | Applied |
| 023 | Voice DNA columns on `user_profiles`; `source` on `generated_posts` | Applied |
| 024 | `post_type`, `quality_verdict` on `generated_posts`; `hook_preview` on `vault_ideas` | Applied |
| 025 | `lead_magnet_template`, `lead_magnet_inputs` on `generated_posts` | Applied |
| 026 | `writing_sample_phrases TEXT` on `user_profiles` | Applied |
| 027 | `website_articles_text TEXT` on `user_profiles` | Applied |
| 028 | `input_examples TEXT` on `user_profiles` | Applied |
| 029 | `ai_content TEXT` on `generated_posts` | Applied |
| 030 | `content_pillars TEXT`, `user_archetype_preference TEXT` on `user_profiles` | Applied |
| 036 | `workspaces`, `workspace_members`, `workspace_invites`, `profiles`, `linkedin_connections`; drops `linkedin_tokens` | **NOT YET applied to prod** |

---

## Current Roadmap

Priority order. Items marked ✅ are shipped; 🔲 are queued; 🚫 are blocked by external constraint.

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | **Apply migration 036 to prod** | 🔲 Next | Workspace/profiles/multi-LinkedIn schema. Maintenance window required. |
| 2 | **LinkedIn profile generator** | 🔲 | Generate headline, about, banner copy from vault + post history. High-ICP value, no competitor has it. |
| 3 | **Pipeline view** | 🔲 | Track warm leads from post comments → discovery call. No partner API needed. Retention metric. |
| 4 | **DM workflow tool** | 🔲 | Human-in-the-loop DM suggestions from vault-grounded copy. No automation, no ToS risk. |
| 5 | **Commenter capture** | 🚫 Blocked | LinkedIn socialActions GET returns 403 ACCESS_DENIED — requires Partner API. Fallback: show commenter name + "View on LinkedIn" link, manual qualification. |
| 6 | **Weekly content plan** | 🔲 | Bob-style weekly plan from cadence + vault + content mix target. Solves blank-page problem permanently. |
| 7 | **Topic DNA Score** | 🔲 | Weekly niche consistency score on dashboard. Enforces positioning focus over time. |
| 8 | **Generate from LinkedIn About on signup** | 🔲 | Draft post from About section within 60s of signup. High activation value. |
| 9 | **Streak & Consistency Tracker** | 🔲 | Publish streak visible on dashboard. Habit-forming. |
| 10 | **Chrome extension** | 🔲 | "Generate from this post" button on LinkedIn feed. Inspiration → draft in one click. |
| 11 | **URL as primary vault entry point** | 🔲 | More prominence for URL input; add YouTube transcript import. |
| 12 | **Multi-language support** | 🔲 | Kleo has 10 languages; gap in market. |
| 13 | **Team seat / operator mode** | 🔲 | Workspace-based; foundation exists in migration 036. Agencies managing multiple personal brands. |
| 14 | **Analytics dashboard** | 🚫 Blocked | Requires LinkedIn Partner API for post-level metrics. Manual upload (Excel export) is the fallback design. |

---

## Known Issues

1. **Migration 036 not applied to prod** — all workspace/profiles/multi-LinkedIn code is complete but gated behind this migration
2. **Profile not tenant-scoped** — `routes/profile.js:15` TODO
3. **Copy events not user-scoped** — `routes/events.js:17` TODO
4. **Phase 2 research path stubbed** — `synthesise.js` has unimplemented `fullResearchSynthesis`
5. **`extractVoiceDNAFromLinkedIn` limited to headline only** — reading past posts requires `r_member_social` LinkedIn Marketing API partner scope (not yet approved)
6. **LinkedIn Partner API** — analytics and commenter auto-capture both blocked without partner status

---

## Strategic Watch List

*Competitor moves that would require roadmap re-prioritisation. See `competitive-intel-2026.md` for full competitive landscape.*

| Trigger | Response |
|---|---|
| Supergrow ships document/vault ingestion | Accelerate lead gen loop — DM workflow + pipeline view become primary moat |
| Kleo ships carousel generation | Lean harder into carousel quality and branded output |
| Kleo ships lead magnet or commenter capture | Sprint pipeline view immediately — race to own content-to-leads category |
| Postiv ships lead magnet / DM workflow | Same — compress pipeline roadmap |
| LinkedIn opens Partner API broadly | Upgrade commenter capture from manual fallback to full auto-ICP scoring; ship analytics |
| Kleo ships multi-profile support | Accelerate team seat / operator mode (Sprint 6 scope) |

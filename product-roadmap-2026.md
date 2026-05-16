# ScoutHook — Product Roadmap 2026

*Strategic review and roadmap based on codebase audit and competitive analysis. Updated 2026-05-13 (launch hardening, security fixes, free plan tightened, signup flow, Mailerlite, help centre).*

---

## What We've Built

ScoutHook is a fully-functional, end-to-end LinkedIn content SaaS — not a prototype. In production today:

- LinkedIn OAuth publishing + BullMQ scheduling with retry logic
- Paddle billing — two-tier launch pricing ($29/mo first 10 users → $39/mo thereafter, locked for life), live subscription sync, auto-recovery if DB record is wiped, past-due detection, cancel flow, and customer portal
- Quality gating with 40+ AI-tell detection patterns
- Vault document extraction (PDF, DOCX, TXT, URL)
- Two-step image generation — user selects which content to include, then chooses between branded carousel (PDF) or quote card; full brand customization
- Document-grounded editorial generation — reshapes the author's own words, cannot add facts not in the source
- Voice fingerprinting — extracts opening style, sentence rhythm, and credibility mechanisms from writing samples; used to personalise post generation
- 8 hook archetypes with Claude Haiku classification
- Funnel-aware post generation (reach / trust / convert)
- Transactional email system via Resend — 10 templates (welcome, limit reached, pro activated, cancelled, expiring soon, payment failed, post published, post failed, LinkedIn reconnect, weekly digest) with deduplication so no email fires twice within a configurable window
- New user onboarding checklist on dashboard — step-by-step setup guide (voice profile → brand settings → vault upload → LinkedIn connect → first publish); auto-hides on completion
- **Auto-first comment on scheduled posts** — AI-suggested, editable; fires 60s after publish via BullMQ; keeps links/CTAs out of post body for better algorithmic reach *(shipped 2026-05-05)*
- **Hook archetype injection in document flow** — `selectHook()` now runs on the editorial path (`restructureToPost`); vault seeds and idea inputs get proper archetype structure instead of generic reshaping; `archetype_used` persisted to `generated_posts` *(shipped 2026-05-06)*
- **Post Performance Tagging** — 🔥/👍/👎 rating on published posts; dashboard "Rate your recent posts" nudge card; "Content Intelligence" card surfaces best archetype + best posting day once ≥3 posts rated; feeds the proof loop *(shipped 2026-05-06)*
- **Viral tension pre-check** — `assessInputQuality()` now blocks generation (HTTP 422 `missing_substance`) when input has no specific outcome AND no surprising angle; amber warning shown inline with "Generate anyway" bypass; applies to both idea and from-doc paths *(shipped 2026-05-06)*
- **PLG onboarding wizard** — 6-screen first-time user flow (`/onboarding.html`): role → goal → website extraction + 3 interview questions → live generation progress → post reveal with "Open in editor" CTA and LinkedIn connection strip; new users are auto-routed from Google OAuth callback; `onboarding_complete` flag gates the redirect *(shipped 2026-05-11)*
- **Email template logo branding** — all 10 transactional email templates updated; text "ScoutHook" header replaced with `sh-logo-dark.png` image (150×35, retina-ready) served via `{{app_url}}/images/sh-logo-dark.png` *(shipped 2026-05-11)*
- **Redis enforced in production; LinkedIn token expiry banner** — server throws on startup if `REDIS_URL` is missing in production; proactive reconnect banner shown in-app when LinkedIn token expires within 7 days *(shipped 2026-05-11)*
- **Paid signup flow** — separate `/login.html` (returning users) and `/signup.html` (new users); new users see a plan-selection screen (ob-s7) at the end of onboarding that fetches live pricing from `/api/billing/config`; returning users with Pro intent are routed to `/billing.html?upgrade=1` *(shipped 2026-05-12)*
- **Mailerlite integration** — free users added to the Mailerlite Free group on first login; Pro activation moves them to the Pro group; cancellation/past_due moves them back; fire-and-forget, non-fatal *(shipped 2026-05-12)*
- **In-app feedback widget** — embedded on all app pages *(shipped 2026-05-12)*
- **In-app help centre** — `/help.html` with FAQ accordion covering 6 common questions; support request form stores to `support_requests` table, emails admin with Pro/Free triage badge, sends user confirmation via Resend *(shipped 2026-05-12)*
- **Security hardening** — Google account chooser forced on every auth (`prompt:'select_account'`) to prevent silent auto-login as the wrong Google account; logout now calls `req.session.destroy()` instead of `req.logout()` (fixes Passport v0.7 session leak where a new cookie was set after every logout); LinkedIn OAuth state validated against the authenticated session user *(shipped 2026-05-13)*
- **Account consolidation on login** — on every Google login, any data stored under a stale `user_id` format (e.g. `google_email:x@y.com` fallback) is silently migrated into the canonical `google:${googleId}` id; self-healing and idempotent; prevents permanent data splits caused by account-picker auto-login bugs *(shipped 2026-05-13)*
- **Launch hardening for 100-user scale** — DB connection pool raised from 10 → 30; Anthropic 429/529 rate-limit errors return HTTP 503 with a user-friendly "high demand" message instead of crashing the generation flow *(shipped 2026-05-13)*

The architecture is sound. The product premise is correct. The engine is better than most users will ever discover, because retention and daily engagement features are thin.

---

## Competitive Position

### ScoutHook vs. Taplio

| Dimension | Taplio | ScoutHook |
|---|---|---|
| Post analytics dashboard | Deep — follower growth, reach, impressions, engagement rate trends | Near zero — manual sync, 90-day wipe |
| Content inspiration | Daily feed of trending posts in your niche | None |
| Lead intelligence | Tracks who engages; CRM-lite view of warm prospects | None |
| Post recycling | Evergreen queue — best posts auto-resurface | None |
| Team features | Multi-seat, shared drafts, approval workflows | Not built |
| Template library | Large community-sourced library | 8 archetypes (system-generated, not browsable) |
| Commenting tools | Comment templates, engagement reminders, 500 credits/mo on Growth tier | Auto-first comment shipped; AI comment on ICP posts in roadmap (Sprint 3) |
| Mobile experience | iOS/Android app | Web-only |
| Brand maturity | $9M raised, 10,000+ users, LinkedIn partner | Early SaaS, no partner status |

### Where ScoutHook Wins

**1. Content quality ceiling is higher.**
Taplio is a topic-to-post generator at its core. It produces the statistical average of LinkedIn content, which LinkedIn's 2026 Authenticity Update actively suppresses. ScoutHook's vault-first approach grounds posts in the user's actual expertise — specific case studies, real data, proprietary frameworks. This is the correct strategic direction for 2026 LinkedIn.

**2. Carousel generation is best-in-class.**
Taplio doesn't touch carousels. ScoutHook generates branded PDF carousels from a single post — the highest-engagement LinkedIn format at 6.6% avg engagement. This alone justifies the subscription for consultants.

**3. Quality gate is a genuine differentiator.**
The 40+ AI-tell blocklist, engagement bait detection, hook length validation, and funnel-type length targets produce consistently better-structured outputs than Taplio. Users who compare side-by-side will notice.

**4. Document-grounded generation preserves content integrity.**
ScoutHook's direct document flow uses an editorial model that reshapes the author's own words — it cannot add facts, statistics, or claims not present in the source. Specific numbers, named clients, and measurable outcomes are preserved verbatim. Taplio generates from topics; ScoutHook generates from the user's actual expertise. The output is unfakeable in a way Taplio's never can be.

---

### ScoutHook vs. Postiv AI

Postiv is the most comprehensive LinkedIn AI system in the market as of May 2026. It is an AI agent (Bob) that manages the user's entire LinkedIn presence: multi-source knowledge ingestion (7 source types, monitored continuously), automatic competitor tracking, weekly content planning, five-layer voice DNA, and saved memory from every chat session. At $99/month it targets power users who want a fully managed LinkedIn presence.

| Dimension | Postiv AI | ScoutHook |
|---|---|---|
| Knowledge ingestion | Website, Newsletter, YouTube, Notion, LinkedIn, Competitors, API — monitored continuously | Vault (PDF, DOCX, TXT, URL) |
| Auto content planning | Weekly plans generated by Bob | Manual |
| Voice learning | 5 layers: extracted style + writing samples + Authority Statements (10) + Content Principles (30) + Saved Memory | Voice fingerprint + writing samples |
| Competitor intelligence | Built-in, continuous | None |
| Inspiration feed | Curated feed + tracked creators + one-click generation | None |
| Lead magnet posts | ❌ | **Roadmap (Sprint 2)** |
| Commenter capture | ❌ | **Roadmap (Sprint 3)** |
| DM workflow | ❌ | **Roadmap (Sprint 3)** |
| Carousel generation | Style import only (upload reference PDF) | ✅ Generated from scratch |
| Quality gate | ❌ | ✅ |
| Price | $99/mo | $39/mo |

**Where ScoutHook wins:**

**Lead generation is the open gap Postiv has left entirely untouched.** No lead magnet post mode, no keyword→DM mechanic, no commenter capture, no lead pipeline view. The entire content-to-leads workflow is ScoutHook's territory.

**Document-grounded content at a different fidelity.** Postiv ingests at topic/context level. ScoutHook preserves verbatim facts, specific data points, named clients, and measurable outcomes — it cannot add facts not in the source. This makes ScoutHook-generated content more specific and harder to AI-detect.

**Quality gate.** 40+ AI-tell patterns, engagement bait detection, hook length validation, viral tension pre-check. Postiv generates without any validation layer.

**Price.** $39/mo vs. $99/mo. Accessible to early-stage founders who need leads before they can justify $99/mo for a content planning tool.

**The strategic split:** Postiv = *"never run out of content."* ScoutHook = *"turn your content into leads."* Sprint 2 and Sprint 3 are what create permanent separation.

---

### The Honest Gap

Taplio wins on depth of post-publish features (analytics, lead tracking, recycling). ScoutHook wins on pre-publish content quality. The problem: most users don't know their content quality is poor until they see performance data. Taplio shows you performance data immediately — even if the posts it helped you write are mediocre.

**ScoutHook produces better posts but gives users no proof. That is the conversion and retention gap.**

### Competitor Viral Post Approaches *(researched 2026-05-06)*

| Tool | Viral post approach | Weakness |
|---|---|---|
| **Taplio** | Trending topic feed in your niche; remix what's already performing. Deep hook-type analytics showing which archetypes work for you personally. | Topic-to-post at its core — posts are generic even when the hook is borrowed from a performer. |
| **Supergrow (Content DNA)** | Analyses your past posts to extract writing patterns, constrains generation to match them. | Optimises for consistency of voice, not consistency of performance. What you wrote before ≠ what performed. |
| **Meet Sona** | 10-minute guided voice interview captures how you think and speak. Authenticity at the sentence level. | Slow UX. Captures voice, not expertise. No document grounding. |
| **Kleo 2.0** | Hook library with real engagement data, sortable by niche and engagement rate. Browse proven structural patterns before writing. | Users still write from scratch. No grounding in their actual expertise. |

**What none of them do:** connect post performance *back* to generation. They all optimise for creation, not the feedback loop. Post Performance Tagging (Sprint 1) is ScoutHook's answer to this gap.

---

## The Strategic Truth

ScoutHook's positioning is correct. The vault-first, expertise-extraction approach is the right bet for 2026 LinkedIn. The technical architecture can support what's needed.

The gap is not in the generation pipeline — it's in the **proof loop**. Users need to see that ScoutHook-generated content is generating the outcome they care about: leads, DM requests, discovery calls — not just impressions.

**The math:** $1M ARR = ~2,140 users at $39/month. This is a realistic number if retention is strong. A future $59/month tier (post-commenting features) would need ~1,430 users.

**The retention problem is the revenue problem.** At 5-7% monthly churn (B2B SaaS baseline), you need 100+ new users/month just to stay flat. ScoutHook's ICP is coaches, consultants, and founders who want inbound leads. Their job-to-be-done is not "publish 5 posts/week" — it is *"get 3 discovery calls this month."* Everything below should be evaluated against that outcome.

Build the proof loop first. Everything else compounds on top of it.

---

## Development Backlog

*Single priority-ordered list. Sprint groupings indicate sequence, not fixed timeboxes.*

---

### Sprint 1 — Generation quality + proof loop foundation ✅ *Shipped 2026-05-06*

**Hook archetype injection in the document flow** ✅
`selectHook()` now runs in parallel with `assessInputQuality()` on the editorial path (`restructureToPost`). The classified archetype's structural hook pattern is injected into `buildRefineSystemPrompt()` via the new `hookInjection` parameter, replacing the generic Rule 1. `archetype_used` is now persisted to `generated_posts` (migration 018). The quality gate and Content Intelligence card can now use real archetype data from all generation paths.

---

**Post Performance Tagging — "What Worked"** ✅
`POST /api/posts/:postId/performance` stores 🔥/👍/👎 tags (+ optional note) against published posts. `GET /api/posts/performance-summary` returns aggregated Content Intelligence: best hook archetype by strong-rate, best day of week. Dashboard surfaces a "Rate your recent posts" nudge card for untagged published posts; "Content Intelligence" card appears once ≥3 posts are rated. Migration 018 adds `performance_tag`, `performance_note`, `performance_tagged_at` columns.

---

**Viral tension pre-check before generation** ✅
`assessInputQuality()` is now active (blocking) on both the idea path and from-doc path. When input has neither a concrete specific nor a surprising angle, the API returns HTTP 422 `missing_substance` with a targeted prompt. The frontend shows an amber inline warning with a "Generate anyway →" bypass. `skipSubstanceCheck` flag lets the bypass re-call without the block.

---

### Sprint 2 — Generation UX + retention signals

**Hook choice visibility and archetype swap**
Users currently get a post and a hookB alternative but don't see which archetype was used or why. Show the chosen archetype ("Written as a MYTH_BUST") with a one-click option to regenerate in a different archetype. Gives users agency and produces posts that match intent, not just the AI's guess.

---

**Post-generation format recommendation**
After generation, analyse the post's structure: 3+ distinct points → recommend carousel (6.6% avg engagement, highest of any LinkedIn format). Before/after arc → flag as strong STORY candidate. ScoutHook already generates branded carousels — users just aren't being steered toward them. Add a format recommendation card in the preview workspace with engagement data as rationale.

---

**Topic DNA Score**
Weekly score: *"Your niche consistency score this month: 78/100. You're building authority in Operational Excellence for Scale-ups."* Gamified, visible on dashboard. LinkedIn's 2026 algorithm rewards topic authority — show users you're helping them build it. Builds on existing quality gate infrastructure.

---

**Streak & Consistency Tracker**
*"You've published 6 weeks in a row."* Simple, but habit-formation research is unambiguous — streaks drive weekly active usage. Weekly active usage is the right retention metric for a LinkedIn tool.

---

**Writing DNA layers — Authority Statements, CTAs library, Content Principles**
ScoutHook has voice fingerprinting but lacks the structured layers that make generation consistently on-brand across every session. Add three new layers to the voice profile settings:
- Authority Statements (up to 10): credibility claims the AI weaves into content — "Built and sold two B2B SaaS companies," "Generated $2M in inbound revenue from LinkedIn for clients"
- CTAs library (up to 10): the user's actual calls-to-action stored and rotated — critical for lead magnet posts and the Commenter Capture mechanic in Sprint 3
- Content Principles (up to 30): specific writing rules — "always give a specific number, never a vague claim," "never use the word leverage"

These feed directly into the system prompt at generation time. Store in `user_profiles`. UI: dedicated "Voice & Brand" tab in settings. The CTAs library is directly prerequisite for the lead magnet keyword reuse mechanic.

---

**Saved Memory from generation sessions**
Every time a user edits a generated post heavily or gives a correction, ScoutHook should learn from it. Detected patterns and explicit corrections get stored as persistent memories, visible and editable in settings. This is the switching cost flywheel — the longer a user stays, the more ScoutHook knows their preferences, and the more foreign every competitor feels by comparison.

---

### Sprint 3 — LinkedIn commenting as a lead engine

*Researched 2026-05-05. Strategy informed by competitive analysis of Taplio, MeetAlfred, Expandi, Supergrow, and Lempod/Podawaa.*

**The opportunity:** LinkedIn comments carry 15× more algorithmic weight than likes in 2026. Inbound LinkedIn leads convert at 14.6% vs. 1.7% for cold outreach. Thoughtful commenting on ICP posts is the highest-ROI daily activity for a consultant or founder — and it takes 45 minutes most people don't have. Taplio charges $149–199/month for unlimited commenting. ScoutHook can match and exceed this.

**What the API supports:** The existing `w_member_social` OAuth scope already covers comment creation via `POST /rest/socialActions/{shareUrn}/comments`. No new LinkedIn partnership or scope change required.

**What to avoid:** Traditional engagement pods (Lempod, Podawaa) are actively penalised — LinkedIn's detection accuracy is 97%, resulting in shadowbans. Generic auto-comments are flagged. The winning approach is contextually relevant, AI-generated comments with human approval before sending.

---

**AI Comment on Target ICP Posts** *(core lead gen engine)*

User builds a target feed — a curated list of people whose posts they want to engage with (ICPs, prospects, niche influencers). For each new post in that feed, ScoutHook surfaces the post text and generates an AI comment in the user's voice, drawing on their vault context for genuine insight. User reviews and approves before it posts — never auto-sends without approval.

- **Targeting:** Add contacts manually, or auto-populate from LinkedIn connections
- **AI generation:** 3 tone options (Add Insight, Congratulate, Ask a Question) — Claude-generated, grounded in the user's vault context so comments reflect real expertise, not generic takes
- **Human-in-the-loop:** Approval required before every send — keeps quality high, avoids spam risk
- **Daily pacing:** Soft cap of 15–20 comments/day shown in the UI (LinkedIn account health)
- **Positioning vs. Taplio:** Taplio's Smart Replies have no vault context — they generate generic takes. ScoutHook's comments can reference the user's actual case studies and frameworks, which reads as genuine expertise, not engagement farming.

*Why this drives leads:* Users become recognisable as experts to their ICP. People notice consistent, insightful comments. Profile visits follow. Inbound DMs follow.

---

**Commenter Capture** *(warm lead CRM — ship after AI commenting)*

Automatically track everyone who comments on the user's own posts. Surface them in a lightweight "Warm Leads" list: name, headline, comment text, post topic. User can add a note, tag as prospect, or dismiss.

- Closes the loop: user comments on ICP posts → ICP comments back → ScoutHook captures them as a warm lead
- No LinkedIn API scraping needed — ScoutHook already syncs post metrics; extend that call to pull commenter identity
- Natural upsell gate — included in a higher tier ("Growth" at $79–89/month) alongside unlimited commenting

---

**Multi-source vault expansion — YouTube, Newsletter, Notion**
Vault today: PDF, DOCX, TXT, URL. High-value expansion for ScoutHook's ICP — most founders have recorded talks, a newsletter, or a Notion knowledge base they want mined for LinkedIn content.

Priority order:
1. YouTube transcript ingestion via YouTube Data API (free, pulls transcript) — founders have podcast appearances, webinars, recorded conference talks
2. Newsletter URL import (crawl Substack, Beehiiv, Ghost — same path as existing URL vault, surfaced as "newsletter" source type with periodic re-sync)
3. Notion sync via OAuth (page selection → periodic re-sync)

Build as vault source type extensions, not new features. Each source type added deepens switching cost and expands the vault's value.

---

**Competitor tracking — LinkedIn post monitoring**
Add 3–5 competitor LinkedIn profiles. Pull their recent posts via existing LinkedIn OAuth read access. Surface in a "Competitors" tab in the vault or inspiration view. For each competitor post: "Contrarian take / What this misses / Your angle" — generates directly into the create flow. Competitive intelligence built into the content workflow. Postiv has this at review time; it is a meaningful daily-use driver.

---

**Auto weekly content plan**
From vault + cadence + audience + Post Performance Tagging history → draft next week's post topics with rationale. Example: "This week: 1 BEFORE_AFTER from your Q1 case study (your strongest archetype by 🔥 rate), 1 lead magnet drop on pricing framework, 1 INSIGHT from your newsletter's most-shared section." Not a rigid plan — a starting point the user can accept, modify, or ignore. Removes blank-page paralysis permanently. Builds on existing hook archetype and performance tagging infrastructure — no new AI infrastructure required.

---

### Sprint 4 — Acquisition and virality

**Case Study Engine**
The #1 lead-generating post type for consultants is the client transformation case study. Structured intake: Client role → Problem → Intervention → Specific results. ScoutHook generates three posts from one client win: a BEFORE_AFTER post, a STORY post, and a STAT_HOOK post. This is a feature that sells itself in demos. No competitor has this.

---

**"Built with ScoutHook" Carousel Attribution**
Add a subtle final slide to every carousel with the ScoutHook URL. Every carousel shared is a branded impression to the exact ICP audience. Opt-out for Pro users, mandatory for Free. This is the Notion/Canva acquisition playbook.

---

**Referral Program**
2 months free Pro for each paid referral. LinkedIn creators have audiences of ideal prospects. The LTV math works. Build simple — a shareable link tracked by Paddle.

---

**Inspiration feed with creator tracking**
Curated LinkedIn feed inside ScoutHook based on the user's stated niche and interests. Add any LinkedIn creator URL to boost their content in the feed. For each post: one-click actions — "Create similar / Contrarian take / Extract key insights" — send the post into the generate flow as context. Creates a daily habit loop (open ScoutHook → find inspiration → make post) that shifts the trigger from "I know what I want to write" to "ScoutHook showed me something worth responding to." Without this, users open ScoutHook only when they already have an idea — a weak trigger for daily usage and retention.

No LinkedIn API partner access required — public creator posts are readable with existing OAuth scope.

---

**Content mix enforcer**
Visual indicator on dashboard and schedule showing rolling 30-day content mix: % of posts that were REACH / TRUST / CONVERT. LinkedIn algorithm rewards a balanced mix — too many lead magnet posts and reach drops. Show recommended mix (e.g. 50/30/20) vs. actual, with a one-click "Generate a [missing type] post" nudge. Low build effort, high perceived value for users who understand LinkedIn strategy.

---

### Sprint 5 — Conversion acceleration

**Comments Coach**
User pastes any LinkedIn post URL → ScoutHook generates 3 substantive comment options in their voice, drawing from vault context. Strategic commenting drives more profile visits than posting for most accounts. Drives **daily** active usage (vs. weekly for posting). No LinkedIn API needed — input URL + existing AI infrastructure.

Pricing: $9/month add-on, or included in a higher tier.

---

**Free Tier Redesign**
Current state (2026-05-13): 10 posts/month on Free; visuals (carousels, quote cards, branded quotes), post scheduling, and analytics (dashboard stats) are Pro-only. Immediate LinkedIn publishing is available on Free.

Remaining direction: move from "limit generations" to "limit publishable posts" — **unlimited generation + 3 publishable posts/month.** This makes the upgrade trigger emotional (*"I have this great post but I can't publish it"*) rather than mechanical (*"I hit my limit"*). Requires a `publishable_posts_count` tracking column (small migration). Deferred to a future sprint.

---

**90-Day Narrative Sprint**
A planned content architecture: 12 weeks, 5 posts/week, organized into:
- Weeks 1–4: Origin Story series (TRUST funnel)
- Weeks 5–8: Methodology + Case Studies (CONVERT funnel)
- Weeks 9–12: Contrarian Takes + Reach posts (REACH funnel)

User fills the vault, ScoutHook generates the full arc. Justifies a $99/month "Sprint" tier. Creates lock-in — users don't churn mid-sprint.

---

### Sprint 6 — Expansion revenue

**Second Seat / Operator Mode**
Consultants and coaches often have a VA or marketing hire doing the posting. Second seat at $20/month (no billing/settings access). Low build cost, straightforward revenue expansion.

---

**Evergreen Queue ("Best Hits")**
Posts tagged as Strong automatically enter an evergreen queue for republication in 90/180 days. One-click schedule. Closes the recycling gap vs. Taplio, uniquely powered by ScoutHook's performance intelligence.

---

## Deferred / Blocked

| Feature | Blocker |
|---|---|
| Post analytics dashboard | LinkedIn API — no partner access |
| Lead intelligence (who engages) | LinkedIn API — no partner access |
| Onboarding vault upload step | Low priority — add vault prompt after first generated post |
| Mobile app | Not yet justified by user volume |

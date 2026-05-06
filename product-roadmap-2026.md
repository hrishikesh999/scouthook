# ScoutHook — Product Roadmap 2026

*Strategic review and roadmap based on codebase audit and competitive analysis. Updated May 2026.*

---

## What We've Built

ScoutHook is a fully-functional, end-to-end LinkedIn content SaaS — not a prototype. In production today:

- LinkedIn OAuth publishing + BullMQ scheduling with retry logic
- Paddle billing with founding-tier pricing
- Quality gating with 40+ AI-tell detection patterns
- Vault document extraction (PDF, DOCX, TXT, URL)
- Carousel PDF generation with brand customization
- Voice fingerprinting + personalized ghostwriter prompt system
- 8 hook archetypes with Claude Haiku classification
- Funnel-aware post generation (reach / trust / convert)
- Transactional email flows (welcome, limit, churn prevention)
- **Auto-first comment on scheduled posts** — AI-suggested, editable; fires 60s after publish via BullMQ; keeps links/CTAs out of post body for better algorithmic reach *(shipped 2026-05-05)*

The architecture is sound. The product premise is correct. The engine is better than most users will ever discover, because retention and daily engagement features are thin.

---

## Competitive Position: ScoutHook vs. Taplio

### Where Taplio Wins

| Dimension | Taplio | ScoutHook |
|---|---|---|
| Post analytics dashboard | Deep — follower growth, reach, impressions, engagement rate trends | Near zero — manual sync, 90-day wipe |
| Content inspiration | Daily feed of trending posts in your niche | None |
| Lead intelligence | Tracks who engages; CRM-lite view of warm prospects | None |
| Post recycling | Evergreen queue — best posts auto-resurface | None |
| Team features | Multi-seat, shared drafts, approval workflows | Not built |
| Template library | Large community-sourced library | 8 archetypes (system-generated, not browsable) |
| Commenting tools | Comment templates, engagement reminders, 500 credits/mo on Growth tier | Auto-first comment shipped; AI comment on ICP posts in roadmap (Priority 2b) |
| Mobile experience | iOS/Android app | Web-only |
| Brand maturity | $9M raised, 10,000+ users, LinkedIn partner | Early SaaS, no partner status |

### Where ScoutHook Wins

**1. Content quality ceiling is higher.**
Taplio is a topic-to-post generator at its core. It produces the statistical average of LinkedIn content, which LinkedIn's 2026 Authenticity Update actively suppresses. ScoutHook's vault-first approach grounds posts in the user's actual expertise — specific case studies, real data, proprietary frameworks. This is the correct strategic direction for 2026 LinkedIn.

**2. Carousel generation is best-in-class.**
Taplio doesn't touch carousels. ScoutHook generates branded PDF carousels from a single post — the highest-engagement LinkedIn format at 6.6% avg engagement. This alone justifies the subscription for consultants.

**3. Quality gate is a genuine differentiator.**
The 40+ AI-tell blocklist, engagement bait detection, hook length validation, and funnel-type length targets produce consistently better-structured outputs than Taplio. Users who compare side-by-side will notice.

**4. Ghostwriter prompt system is architecturally superior.**
The 60K-char vault context distillation into a personalized ghostwriter system prompt is a real moat. The longer a user stays, the more ScoutHook knows about their expertise, audience, and voice. Taplio has no equivalent.

### The Honest Gap

Taplio wins on depth of post-publish features (analytics, lead tracking, recycling). ScoutHook wins on pre-publish content quality. The problem: most users don't know their content quality is poor until they see performance data. Taplio shows you performance data immediately — even if the posts it helped you write are mediocre.

**ScoutHook produces better posts but gives users no proof. That is the conversion and retention gap.**

---

## The One Killer Feature

### "What Worked" — Self-Reported Post Intelligence Layer

**Diagnosis:** ScoutHook's ICP is coaches, consultants, and founders who want inbound leads. The user's job-to-be-done is not "publish 5 posts/week." It is *"get 3 discovery calls this month."* Everything ScoutHook builds should be evaluated against that outcome.

Right now, ScoutHook stops at the moment of publish. There's no signal of whether the content is working. Users have no reason to believe ScoutHook is driving leads, because no one is showing them the connection.

**The mechanism:**

1. After every published post, a 24-hour prompt appears: *"How did this post perform? Any leads, DM requests, or profile visits worth noting?"*
2. User taps: 🔥 Strong / 👍 Decent / 👎 Weak — plus an optional note
3. Over time, ScoutHook correlates: hook archetype × funnel type × format × day of week × topic cluster → performance pattern
4. Every Monday, a "Content Intelligence" card: *"Your CONFESSION hooks outperform INSIGHT hooks 3:1. Your Tuesday posts get 2x the DMs of Thursday posts."*
5. Next post generation automatically weights toward high-performing patterns

**Why this is the killer feature:**

- **Zero LinkedIn API dependency.** It's a form. Works today.
- **Creates a retention flywheel.** The product gets smarter the longer you use it. Month 3 ScoutHook is dramatically more valuable than Month 1 ScoutHook.
- **Closes the proof gap.** Users can see that ScoutHook-generated posts outperform their old content. That's the testimonial. That's the word-of-mouth. That's the case study.
- **Justifies price increases.** Six months of performance data = leverage for a $99/month "Advanced Intelligence" tier.
- **Feeds the ghostwriter prompt.** High-performing posts auto-update writing samples. Output quality compounds over time.

No competitor is doing this for LinkedIn, because they're racing to get API access instead of building around the constraint.

---

## Roadmap to $1M ARR

**The math:** $1M ARR = ~1,700 users at $49/month, or ~1,430 users at $59/month. This is 1,700 people — a realistic number if retention is strong.

**The retention problem is the revenue problem.** At 5-7% monthly churn (B2B SaaS baseline), you need 100+ new users/month just to stay flat. Every feature below is ranked by its payback loop — how fast it creates a reason to stay.

---

### Priority 1 — Retention Infrastructure (Month 1–2)

**1a. Post Performance Tagging**
The single highest-leverage retention feature. Self-reported 🔥/👍/👎 rating after publish. Builds personalized content intelligence over time. Users who see "ScoutHook learned what works for me" don't churn.

**1b. Topic DNA Score**
Weekly score: *"Your niche consistency score this month: 78/100. You're building authority in Operational Excellence for Scale-ups."* Gamified, visible on dashboard. LinkedIn's 2026 algorithm rewards topic authority — show users you're helping them build it. Builds on existing quality gate infrastructure.

**1c. Streak & Consistency Tracker**
*"You've published 6 weeks in a row."* Simple, but habit-formation research is unambiguous — streaks drive weekly active usage. Weekly active usage is the right retention metric for a LinkedIn tool.

---

### Priority 2 — Acquisition Virality (Month 2–3)

**2a. "Built with ScoutHook" Carousel Attribution**
Add a subtle final slide to every carousel with the ScoutHook URL. Every carousel shared is a branded impression to the exact ICP audience. Opt-out for Pro users, mandatory for Free. This is the Notion/Canva acquisition playbook.

**2b. Case Study Engine**
The #1 lead-generating post type for consultants is the client transformation case study. Structured intake: Client role → Problem → Intervention → Specific results. ScoutHook generates three posts from one client win: a BEFORE_AFTER post, a STORY post, and a STAT_HOOK post. This is a feature that sells itself in demos. No competitor has this.

**2c. Referral Program**
2 months free Pro for each paid referral. LinkedIn creators have audiences of ideal prospects. The LTV math works. Build simple — a shareable link tracked by Paddle.

---

### Priority 2b — LinkedIn Commenting as a Lead Engine (Month 2–3)

*Researched 2026-05-05. Strategy informed by competitive analysis of Taplio, MeetAlfred, Expandi, Supergrow, and Lempod/Podawaa.*

**The opportunity:** LinkedIn comments carry 15× more algorithmic weight than likes in 2026. Inbound LinkedIn leads convert at 14.6% vs. 1.7% for cold outreach. Thoughtful commenting on ICP posts is the highest-ROI daily activity for a consultant or founder — and it takes 45 minutes most people don't have. Taplio charges $149–199/month for unlimited commenting. ScoutHook can match and exceed this.

**What the API supports:** The existing `w_member_social` OAuth scope already covers comment creation via `POST /rest/socialActions/{shareUrn}/comments`. No new LinkedIn partnership or scope change required.

**What to avoid:** Traditional engagement pods (Lempod, Podawaa) are actively penalised — LinkedIn's detection accuracy is 97%, resulting in shadowbans. Generic auto-comments are flagged. The winning approach is contextually relevant, AI-generated comments with human approval before sending.

---

**Feature 2a — AI Comment on Target ICP Posts** *(core lead gen engine)*

User builds a target feed — a curated list of people whose posts they want to engage with (ICPs, prospects, niche influencers). For each new post in that feed, ScoutHook surfaces the post text and generates an AI comment in the user's voice, drawing on their vault context for genuine insight. User reviews and approves before it posts — never auto-sends without approval.

- **Targeting:** Add contacts manually, or auto-populate from LinkedIn connections
- **AI generation:** 3 tone options (Add Insight, Congratulate, Ask a Question) — Claude-generated, grounded in the user's vault context so comments reflect real expertise, not generic takes
- **Human-in-the-loop:** Approval required before every send — keeps quality high, avoids spam risk
- **Daily pacing:** Soft cap of 15–20 comments/day shown in the UI (LinkedIn account health)
- **Positioning vs. Taplio:** Taplio's Smart Replies have no vault context — they generate generic takes. ScoutHook's comments can reference the user's actual case studies and frameworks, which reads as genuine expertise, not engagement farming.

*Why this drives leads:* Users become recognisable as experts to their ICP. People notice consistent, insightful comments. Profile visits follow. Inbound DMs follow. This is the mechanism behind "thought leadership" — ScoutHook makes it systematic and fast.

---

**Feature 2b — Commenter Capture** *(warm lead CRM, ship after 2a)*

Automatically track everyone who comments on the user's own posts. Surface them in a lightweight "Warm Leads" list: name, headline, comment text, post topic. User can add a note, tag as prospect, or dismiss.

- Closes the loop: user comments on ICP posts → ICP comments back → ScoutHook captures them as a warm lead
- No LinkedIn API scraping needed — ScoutHook already syncs post metrics via `/rest/socialMetadata`; extend that call to pull commenter identity
- Positioning: This is Taplio's "Commenters" auto-list, but with vault-aware context on why they engaged

*Revenue angle:* Commenter Capture is a natural upsell gate — included in a higher tier ("Growth" at $79–89/month) alongside unlimited commenting. Users who see leads appearing in a list don't churn.

---

### Priority 3 — Conversion Acceleration (Month 3–4)

**3a. Free Tier Redesign**
Current: 3 quality-gate passes/month. Problem: users hit the wall before proving value to themselves.

New model: **Unlimited generation + 3 publishable posts/month.** Let users see ScoutHook's quality on every post — they just can't publish the fourth. The upgrade trigger becomes emotional (*"I have this great post but I can't publish it"*) not mechanical (*"I hit my limit"*).

**3b. Comments Coach**
User pastes any LinkedIn post URL → ScoutHook generates 3 substantive comment options in their voice, drawing from vault context. Strategic commenting drives more profile visits than posting for most accounts. Drives **daily** active usage (vs. weekly for posting). No LinkedIn API needed — input-URL + existing AI infrastructure.

Pricing: $9/month add-on, or included in a higher tier.

**3c. 90-Day Narrative Sprint**
A planned content architecture: 12 weeks, 5 posts/week, organized into:
- Weeks 1–4: Origin Story series (TRUST funnel)
- Weeks 5–8: Methodology + Case Studies (CONVERT funnel)
- Weeks 9–12: Contrarian Takes + Reach posts (REACH funnel)

User fills the vault, ScoutHook generates the full arc. Justifies a $99/month "Sprint" tier. Creates lock-in — users don't churn mid-sprint.

---

### Priority 4 — Expansion Revenue (Month 4–6)

**4a. Second Seat / Operator Mode**
Consultants and coaches often have a VA or marketing hire doing the posting. Second seat at $20/month (no billing/settings access). Low build cost, straightforward revenue expansion.

**4b. Evergreen Queue ("Best Hits")**
Posts tagged as Strong automatically enter an evergreen queue for republication in 90/180 days. One-click schedule. Closes the recycling gap vs. Taplio, uniquely powered by ScoutHook's performance intelligence.

---

---

## Viral Post Generation — Improvements Backlog

Decisions made 2026-05-06: Ghostwriter (weekly batch flow) removed. Direct document upload flow is now the primary document-grounded generation path. The hook archetype system — already built for the idea path — is not yet connected to the document flow. These items close that gap and add a compounding virality layer on top.

### V1 — Connect existing infrastructure (low effort, high leverage)

**V1a. Hook archetype injection in the document flow**
The idea path runs Haiku hook classification → selects from 8 archetypes → injects the archetype's structural hook pattern into generation. The document path (`restructureToPost`) uses a separate editorial model with no hook logic at all. Fix: run `selectHook()` on the extracted document text, inject the archetype's structure into `buildRefineSystemPrompt()`. One function change, no new AI calls. Immediately makes document-based posts structurally stronger.

*Why it matters:* A case study with a MYTH_BUST angle ("everyone thinks X, but the data says Y") currently gets a generic editorial reshaping. With archetype injection it gets a properly structured myth-bust hook. The viral mechanics engine is already built — it's just not wired to the document flow.

**V1b. Viral tension pre-check before generation**
`assessInputQuality()` already checks for specificity and tension on the idea path but produces only a passive feedback string. Make it active on both paths: if the document or idea lacks a concrete result or surprising angle, surface a blocking prompt before generation — "This document has no specific client outcome. Add one sentence with a real number and the post will perform significantly better." Halt-and-ask rather than generate-and-hope.

**V1c. Surface hook choice and let users swap archetypes**
Users currently get a post and a hookB alternative but don't see which archetype was used or why. Show the chosen archetype ("Written as a MYTH_BUST") with a one-click option to regenerate in a different archetype. Gives users agency and produces posts that match intent, not just the AI's guess.

---

### V2 — Format intelligence (medium effort)

**V2a. Post-generation format recommendation**
After generation, analyse the post's structure: 3+ distinct points → recommend carousel (6.6% avg engagement, highest of any LinkedIn format). Before/after arc → flag as strong STORY candidate. ScoutHook already generates branded carousels — users just aren't being steered toward them. Add a format recommendation card in the preview workspace that surfaces this with engagement data as the rationale.

---

### V3 — Performance feedback loop (Priority 1 from original roadmap — compounding flywheel)

**V3a. Post Performance Tagging ("What Worked")**
After every published post, show a 24-hour prompt: "How did this post perform? Any leads, DMs, or profile visits worth noting?" User taps 🔥 Strong / 👍 Decent / 👎 Weak + optional note. No LinkedIn API required — this is a form.

Over time, ScoutHook correlates: hook archetype × format × day of week × topic cluster → performance pattern. Every Monday, a "Content Intelligence" card: "Your MYTH_BUST hooks outperform INSIGHT hooks 3:1. Your Tuesday posts get 2x the DMs of Thursday posts."

Next post generation automatically weights toward high-performing patterns. Output quality compounds over time.

*Why this is the most important item:* None of the other improvements compound without this. It also closes the proof gap — users can see that ScoutHook-generated posts are driving their actual business outcomes (leads, DMs, discovery calls), not just impressions. That's the retention flywheel and the case study engine.

*Competitive advantage:* No competitor is doing this for LinkedIn, because they're all racing to get API access. Self-reported performance data sidesteps the API limitation entirely and produces more accurate signal (a DM is worth more than a like, but only the user knows it happened).

---

## Competitive Landscape — 2026 Update

*(Researched and updated 2026-05-06)*

| Tool | Viral post approach | Weakness |
|---|---|---|
| **Taplio** | Trending topic feed in your niche; remix what's already performing. Deep hook-type analytics showing which archetypes work for you personally. | Topic-to-post at its core — posts are generic even when the hook is borrowed from a performer. |
| **Supergrow (Content DNA)** | Analyses your past posts to extract writing patterns, constrains generation to match them. | Optimises for consistency of voice, not consistency of performance. What you wrote before ≠ what performed. |
| **Meet Sona** | 10-minute guided voice interview captures how you think and speak. Authenticity at the sentence level. | Slow UX. Captures voice, not expertise. No document grounding. |
| **Kleo 2.0** | Hook library with real engagement data, sortable by niche and engagement rate. Browse proven structural patterns before writing. | Users still write from scratch. No grounding in their actual expertise. |

**What none of them do:** connect post performance *back* to generation. They all optimise for creation, not the feedback loop. V3a (Post Performance Tagging) is ScoutHook's answer to this gap.

---

## Features Already Deferred (from Sprint Backlog)

| Feature | Notes |
|---|---|
| Post-publish coaching modal (Golden Hour) | Foundational to the performance loop above — ship first |
| Carousel as recommended format | Add engagement data labels to format buttons |
| Topic DNA enforcement | Warn when post drifts outside user's niche |
| Onboarding vault upload step | Add vault prompt after first generated post |
| Phase 1 analytics feedback loop | Blocked by LinkedIn API — replace with self-reported model |

---

## The Strategic Truth

ScoutHook's positioning is correct. The vault-first, expertise-extraction approach is the right bet for 2026 LinkedIn. The technical architecture can support what's needed.

The gap is not in the generation pipeline — it's in the **proof loop**. Users need to see that ScoutHook-generated content is generating the outcome they care about: leads, DM requests, discovery calls — not just impressions.

Build the proof loop first. Everything else compounds on top of it.

The $1M ARR number is achievable in 12 months if retention improves from the current baseline. The single most dangerous assumption in the current product is that users will stay because the posts are objectively better quality. They won't. **They'll stay because they can see the results.**

# LinkedIn Content Pipeline — Feature Roadmap

Research conducted July 2026. Cross-referenced against ScoutHook's generation pipeline.

**Organizing principle:** Features are ordered by what immediately improves the quality of the generated post, not by LinkedIn algorithm signal importance. Algorithm compliance and post-publish coaching matter — but only after the posts themselves are worth publishing.

---

## Tier 1 — Immediate Generation Quality
*Changes to generation prompts and pipeline that make every post Claude writes better. Mostly prompt edits — lowest effort, highest leverage. Do these first.*

---

### 01 · Block 2026 viral template phrases
**Effort:** ~30 min  
**Files:** `services/qualityGate.js`, `services/postSanitiser.js`

The current `AI_GIVEAWAY_PHRASES` list covers obvious AI tells but misses the 2026-specific copywriting patterns that are now so saturated they read as templates. These aren't just algorithm flags — they make posts sound like every other ghostwriter's output, which destroys the voice work ScoutHook does upstream.

Add regex patterns for:
- `"Stop [X], start [Y]"` construction
- `"Here's what nobody tells you"`
- `"The result?"` as a standalone line (line-start match)
- `"It's not [X], it's [Y]"` inversion

Add to `AI_TELLS_PROHIBITION` in `postSanitiser.js` so the model never writes them. Add to `AI_GIVEAWAY_PHRASES` in `qualityGate.js` so they get flagged if they slip through (-10 per hit, combined cap).

---

### 02 · "Hold your strongest point" — depth score structural move
**Effort:** ~45 min  
**Files:** `services/hookArchetypes.js`, `services/ideaPath.js` (`SELF_CHECK`)

The current archetype `bodyStructure` arrays define what moves to make but not where to place the best one. Posts that front-load their strongest insight give the reader no reason to finish reading. The LinkedIn Depth Score rewards posts that accumulate reading time — which means the best insight should come in the final third, not the middle.

Add a move to every archetype's `bodyStructure` array:

> "DEPTH MOVE: Save the sharpest, most surprising insight for the final third. Readers who reach it should feel rewarded for finishing. Do not give everything away in the setup."

Also add as item 6 in `SELF_CHECK` in `ideaPath.js`. One line per archetype, 8 archetypes total. No architecture change needed.

---

### 03 · Debate-igniting CTA for reach posts
**Effort:** ~1h  
**Files:** `services/ideaPath.js` (`buildCtaInstruction`), `services/contrarianHotTakePath.js`

The current reach CTA instruction produces questions like "Have you experienced this?" — useful, but they generate one-off replies, not threads. Posts that spark back-and-forth debate between multiple readers reach 3.2× further. The CTA is what determines which one happens.

Upgrade `buildCtaInstruction()` for reach posts to require: a question with two genuine opposing sides — polarizing enough that readers who disagree feel compelled to say so publicly. The goal is seven people arguing, not seven people agreeing.

Example direction to add: *"Not 'What has been your experience?' but 'Hot take: [contrarian position from the post]. Where am I wrong?' The question must have a real right and wrong answer that people will fight over."*

Apply the same upgrade to the closing question instruction in `contrarianHotTakePath.js`.

---

### 04 · Vault verbatim extraction — use the user's exact words in posts
**Effort:** ~3h  
**Files:** `services/vaultContext.js`, `services/ideaPath.js`

This is the highest-quality-per-effort change on the entire list. Currently `vaultContext.js` retrieves relevant chunks from the user's vault and passes them as background context. Claude then synthesises that context — which means the user's original wording, their actual case study results, their specific frameworks, all get paraphrased away. The post ends up sounding like Claude summarised someone else's expertise.

Changing the instruction from "use this as background" to "quote this verbatim when relevant" transforms vault content from a context hint into an authenticity engine. A sentence from the user's own case study or methodology document — their exact words — is a post no competitor can replicate with the same AI tool.

What to build:
1. In `vaultContext.js`, return raw source text alongside the summary for each retrieved chunk
2. In `ideaPath.js`, update the vault injection block: *"If a vault passage is directly relevant, quote the author's exact wording in the post — do not paraphrase. Only quote if the passage is clearly relevant; if uncertain, omit entirely."*
3. Add a confidence threshold so low-relevance chunks are excluded rather than forced in
4. Surface a visual indicator in the editor when the post contains vault-sourced text (e.g. "from your vault" tooltip on hover)

---

### 05 · "Save" funnel type — reference-value content generation
**Effort:** ~2h  
**Files:** `modules/formatIntelligence/rules.js`, `services/ideaPath.js`

The current three funnel types (reach, trust, convert) produce posts designed to attract, build credibility, or drive action. None of them are optimised for posts people bookmark — dense-information posts that readers return to. These are structurally different: shorter, data-heavy, framework-driven, and written to be referenceable rather than read once and forgotten.

Add `"save"` as a 4th funnel type in `rules.js` `postLengthTargets` and `ideaPath.js` `buildPostTypeBlock()`:
- Length: 250–400 words (tight — every line earns its place)
- Structure: numbered framework, checklist, or dense stat cluster
- Archetype preference: INSIGHT and NUMBER
- CTA: "Save this for next time you [specific situation]"
- Closing: reader should feel they need to bookmark it, not that they've finished reading it

---

## Tier 2 — Quality Gates
*Checks that catch mistakes before posts go out. Don't improve the generated text — prevent it from being self-defeating.*

---

### 06 · External URL detector in quality gate
**Effort:** ~30 min  
**Files:** `services/qualityGate.js`, `modules/formatIntelligence/rules.js`

**Research signal:** External links in post body = 50–70% reach penalty, got measurably worse June 2026.

Quality gate has no check for URLs in the post body. Every user who pastes a link into their post loses up to 70% of potential reach with no warning. Add a regex check for http/https/www patterns, flag `EXTERNAL_LINK_IN_BODY`, deduct score, and show an actionable nudge: "Move this link to your first comment — we'll draft it for you." Wire the CTA to the existing suggest-first-comment endpoint.

---

### 07 · Above-the-fold hook character validation
**Effort:** ~1h  
**Files:** `services/qualityGate.js`, `modules/formatIntelligence/rules.js`

**Research signal:** Mobile "see more" fold cuts at ~140 characters. 60–70% of readers never tap "see more."

Quality gate counts words but not characters of the first line. Add a `firstLineCharCount` check: extract text before the first blank line or newline sequence, count characters, flag `HOOK_TOO_LONG` if above 140 characters as a soft warning (-10 score): "Your hook may be cut off on mobile before 'see more'. Trim to 140 characters or remove the line break."

---

### 08 · Character count enforcement (optimal 1,301–2,500 chars)
**Effort:** ~1h  
**Files:** `services/qualityGate.js`, frontend editor UI

**Research signal:** Posts in the 1,301–2,500 character range produce the highest median engagement rate (2.61–2.67%). Posts under 400 characters average only 2.10%.

Quality gate enforces word count but not character count. Add a `totalCharCount` check. Target range: 900–2,500 characters. Flag `SHORT_CHARACTER_COUNT` below 600 characters as a soft warning. Surface the character count in the editor alongside the word count so users can calibrate.

---

## Tier 3 — Post-Publish Reach Optimization
*These features don't improve the post — they maximize reach after it goes live. High value, but only after the post quality is sorted.*

---

### 09 · Upgraded first-comment generation
**Effort:** ~1h  
**Files:** `routes/linkedin.js:1215`

**Research signal:** Comments containing external links get 80% less visibility. The author's own first comment sets the tone for thread quality.

Upgrade the suggest-first-comment prompt to: (1) accept an optional `link` parameter — if a URL was moved from the post body by the quality gate, prepend it here naturally; (2) generate a controversy-inviting question as the comment body, not just a CTA; (3) frame the question to start a multi-reply thread rather than a single agree/disagree response.

---

### 10 · Optimal publish time suggestion in scheduler
**Effort:** ~1h  
**Files:** `routes/linkedin.js` (schedule endpoint), frontend scheduler UI

**Research signal:** Tuesday–Thursday 7–9am in the user's timezone is peak LinkedIn feed activity.

When a user picks a publish time, surface a contextual hint: "For peak reach, aim for Tuesday–Thursday 7–9am [detected timezone]." Longer term, use historical engagement data already synced via `linkedinMetrics` to suggest the specific hour that has worked best for that user.

---

### 11 · Golden hour post-publish coaching
**Effort:** ~2h  
**Files:** `services/linkedinPublisher.js`, `services/scheduler.js`, notifications DB

**Research signal:** Author reply within 15 minutes = 90% algorithmic boost. Within 30 minutes = 64% more comments + 2.3× more views.

After every publish, fire a notification via the existing notifications system: "Your post is live. Reply to early comments within 15 minutes — that's when reach multiplies." For scheduled posts, add a follow-up notification 5 minutes post-publish. No generation changes needed.

---

## Tier 4 — Analytics & Intelligence
*Feedback loops that help users learn what works over time. Zero effect on individual post quality — builds compounding advantage.*

---

### 12 · Add saves to LinkedIn metrics sync
**Effort:** ~1.5h  
**Files:** `services/linkedinMetrics.js`, `migrations/`, `routes/performance.js`

**Research signal:** One save = 5× a like, 2× a comment. Posts with >2% save rate get secondary distribution waves at 24h and 48h.

`linkedinMetrics.js` only syncs likes, comments, reactions. LinkedIn's Social Metadata API now exposes save counts. Add a `saves` column to `generated_posts`, pull it in `fetchLinkedInMetrics()`, persist it, and surface save rate in the performance dashboard. This unlocks a feedback loop: which post types and archetypes drive saves.

---

### 13 · Niche hashtag guidance (50K–500K follower range)
**Effort:** ~1h  
**Files:** `modules/formatIntelligence/rules.js`, `services/postSanitiser.js`

**Research signal:** Hashtags with 1M+ followers are too competitive — posts get buried. Niche hashtags (50K–500K) are the correct range for interest-graph discovery.

Add hashtag range guidance to generation prompts. Surface a note in the editor: "Use niche hashtags (50K–500K followers) — broad ones like #marketing (40M followers) won't help you get discovered."

---

### 14 · Topic authority tracking + pillar drift warning
**Effort:** ~4h  
**Files:** `routes/generate.js`, `routes/performance.js`, `migrations/`

**Research signal:** LinkedIn shifted from Relationship Graph to Interest Graph. Consistent posting on 3–4 topics builds compounding reach. Posting across 5+ unrelated topics dilutes algorithmic authority.

Tag each generated post with its primary content pillar at generation time. Store as `pillar_tag` on `generated_posts`. In the performance dashboard, show a "Topic mix" breakdown of the last 30 days. When a post falls outside defined pillars, show a soft prompt: "Consistent focus on [pillar 1] and [pillar 2] builds stronger algorithmic authority — is this intentional?"

---

### 15 · Comment depth metric (threads vs. isolated count)
**Effort:** ~2h  
**Files:** `services/linkedinMetrics.js`, `routes/performance.js`

**Research signal:** A post with 5 comments in one back-and-forth thread is algorithmically far more valuable than 5 isolated comments.

LinkedIn's `commentsSummary.totalFirstLevelComments` counts isolated top-level comments only. Check whether the API exposes nested reply counts; if so, add a `thread_depth` metric. If not, surface coaching in the performance dashboard: "Comments that spark replies carry 15× more algorithmic weight than isolated comments."

---

### 16 · Posting frequency coaching (3–5/week rhythm)
**Effort:** ~3h  
**Files:** `routes/performance.js`, frontend dashboard

**Research signal:** 3–5 posts per week is optimal. Daily posting without quality dilutes topic authority faster than it builds reach.

Surface a posting rhythm panel in the dashboard: posts published in the last 7 days, whether above/below the 3–5/week target, streak indicator. If below: "Consistent posting on [pillar] builds topic authority — aim for 3 posts this week." Uses data already stored in `generated_posts` timestamps.

---

### 17 · Personal profile vs. company page positioning
**Effort:** ~30 min  
**Files:** Onboarding copy / UI tooltips

**Research signal:** Personal profiles receive ~65% of LinkedIn feed allocation; company pages ~5%. Personal profiles generate 5–10× more reach for identical content.

One-time educational moment during onboarding: "ScoutHook generates posts for your personal profile — which gets 10× more feed reach than a company page. Everything we build is optimised for this advantage." Zero development cost if added to onboarding copy.

---

## Tier 5 — New Formats
*Expand what ScoutHook can generate. Strategic capability-building — do after the core pipeline is solid.*

---

### 18 · Newsletter excerpt post type
**Effort:** ~4h  
**Files:** `routes/generate.js`, `services/newsletterExcerptPath.js` (new)

**Research signal:** LinkedIn newsletters bypass the feed algorithm — delivered via push notification and email directly to subscribers, guaranteeing future reach.

Add a `"newsletter"` post type. Input: newsletter topic or excerpt + author context. Output: CURIOSITY_GAP or INSIGHT hook that teases the issue compellingly enough to drive subscription. Ends with: "Subscribe to [name] — link in first comment." The first-comment generator automatically drafts the newsletter link comment. Length: 200–350 words (convert-style).

---

### 19 · Video script post type
**Effort:** ~6h  
**Files:** `routes/generate.js`, `services/videoScriptPath.js` (new)

**Research signal:** Native vertical video (30–90 seconds, 1080×1920) is the highest new organic reach opportunity in 2026 — 5–10× more reach than text posts for non-followers.

New generation path `videoScriptPath.js`. Input: raw idea + author context. Output: structured script with (1) 3-second visual hook description, (2) spoken lines timed to 30/60/90 seconds with beat markers, (3) on-screen text overlays for key points, (4) CTA line for the last 5 seconds. Caption generated separately as a trust/reach post.

---

## Summary Table

| # | Feature | Tier | Effort |
|---|---------|------|--------|
| 01 | Block 2026 viral template phrases | Generation quality | 30 min |
| 02 | "Hold your strongest point" archetype move | Generation quality | 45 min |
| 03 | Debate-igniting CTA for reach posts | Generation quality | 1h |
| 04 | Vault verbatim extraction | Generation quality | 3h |
| 05 | "Save" funnel type | Generation quality | 2h |
| 06 | External URL detector | Quality gate | 30 min |
| 07 | Above-the-fold hook validation | Quality gate | 1h |
| 08 | Character count enforcement | Quality gate | 1h |
| 09 | Upgraded first-comment generation | Post-publish | 1h |
| 10 | Optimal publish time suggestion | Post-publish | 1h |
| 11 | Golden hour post-publish coaching | Post-publish | 2h |
| 12 | Saves metric tracking | Analytics | 1.5h |
| 13 | Niche hashtag guidance | Analytics | 1h |
| 14 | Topic authority tracking | Analytics | 4h |
| 15 | Comment depth metric | Analytics | 2h |
| 16 | Posting frequency coaching | Analytics | 3h |
| 17 | Personal profile positioning | Analytics | 30 min |
| 18 | Newsletter excerpt post type | New format | 4h |
| 19 | Video script post type | New format | 6h+ |

**Tier 1 only (generation quality):** ~7.5h total  
**Tiers 1–2 (quality + gates):** ~10h total  
**All 19 features:** ~35h total

---

## Future Milestone — Google Drive Vault Sync

Not on the current roadmap. Evaluated as a product milestone for a later phase.

**The concept:** Persistent Google Drive connection where users select folders to sync. ScoutHook pulls all files, converts them to Markdown (without AI where possible — native for .docx, Google Docs, .pptx; text-extraction for text-based PDFs), and stores them in the Vault database. New files added to synced folders are auto-detected and ingested via Drive webhooks. The resulting knowledge base powers both the idea generator and post generation, with feature 04 (vault verbatim extraction) handling how that content surfaces in posts.

**Why it's a milestone not a feature:** Requires Google OAuth, Drive API integration, folder-level change detection (push notifications), multi-format file conversion, background ingestion workers, and storage scaling beyond the current SQLite setup. Realistic build: 3–4 weeks. Should follow the current 19-feature roadmap, not run in parallel with it.

**Staged delivery when ready:**
1. Google Drive OAuth + folder selection + one-time bulk import
2. Auto-sync via Drive webhooks for new/modified files
3. Personalised content suggestions based on recently synced documents

---

*Research sources: LinkedIn algorithm analysis across linkboost.co, melaniegoodmanlinkedinconsultant.substack.com, growleads.io, dataslayer.ai, socialinsider.io, markanamedia.com, zoomsphere.com, linkhub.gg, meet-lea.com, and others. Analysis date: July 2026.*

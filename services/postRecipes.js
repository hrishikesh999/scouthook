'use strict';

/**
 * services/postRecipes.js — declarative registry for the 10 guided post types.
 *
 * Before the consolidation each type lived in its own services/*Path.js as a
 * ~180-line clone (a "Justin Welsh" persona prompt, a mandated 3-hashtag block,
 * a copy-pasted author-context builder, and a rigid "FOLLOW THIS STRUCTURE
 * (EXACT)" recipe). The only genuinely distinct asset in each file was the
 * structure recipe. This registry keeps exactly that — one `structureGuide`
 * per type — and lets services/postEngine.js supply everything else (authenticity
 * core, author context, published examples, CTA handling, output rules) from a
 * single place. See sprint-authenticity-pipeline.md (Phase 2).
 *
 * Design notes carried over from the diagnosis:
 * - NO persona. The only voice is the author's (via Voice DNA + phrase library +
 *   their own published posts). "Justin Welsh" is the most-imitated voice on
 *   LinkedIn and steering toward it is exactly what the 2026 classifier flags.
 * - NO mandated hashtags. The engine's OUTPUT block forbids them.
 * - Structure guides are LOOSE. "Shape the post around these beats" replaces
 *   "FOLLOW THIS STRUCTURE (EXACT)" so posts stop sharing one skeleton.
 *
 * Fields:
 *   goal              funnel intent (reach|trust|convert|save) — informational for
 *                     now; Phase 6 splits goal × format into orthogonal axes.
 *   acceptsCtaIntent  whether a user-supplied CTA intent applies (the closing for
 *                     types without it is baked into structureGuide).
 *   includeCraftRules whether hook/above-the-fold/depth/POV rules apply (off for
 *                     goodwill posts where a scroll-stopping hook fights intent).
 *   allowEnumeration  whether numbered/dashed lists are the right format (frameworks).
 *   inputLabel        prefix for the raw idea in the user prompt ('' = idea alone).
 *   maxTokens         completion budget.
 */

const RECIPES = {
  // ── trust — Authority / Expertise ─────────────────────────────────────────
  trust: {
    slug: 'trust',
    goal: 'trust',
    acceptsCtaIntent: true,
    includeCraftRules: true,
    allowEnumeration: false,
    inputLabel: 'WHAT TO TEACH OR CLARIFY:',
    maxTokens: 1500,
    structureGuide: `This is an AUTHORITY / EXPERTISE post: clarify one idea the author understands deeply, in a way that builds credibility and trust.
- Teach through explanation, not instruction. Let credibility come from the quality of the insight, not from claims about yourself.
- One core idea per post. Clarity over cleverness. No hype, no self-praise.
Shape the post around: a specific, grounded opening that frames the idea; the reasoning that makes it true; and a reframe or reflection that cements the author's authority. Show the reasoning — do not just state the conclusion.`,
  },

  // ── story — Story / Personal Experience ───────────────────────────────────
  story: {
    slug: 'story',
    goal: 'reach',
    acceptsCtaIntent: true,
    includeCraftRules: true,
    allowEnumeration: false,
    inputLabel: '',
    maxTokens: 1500,
    structureGuide: `This is a STORY / PERSONAL EXPERIENCE post: an emotionally honest moment that builds trust and connection.
Move through: an emotional or curiosity-driven opening; what happened, in plain human language; what made it hard (internal honesty, not manufactured drama); the moment something shifted; and what it means for the reader.
- Human over polished. Honest over inspirational. Emotional truth over spectacle.
- Do not invent details that were not given. If the outcome is unstated, imply it subtly rather than fabricating specifics.
Vary the weight of each beat; never give all beats equal length. Let the point land without a tidy moral wrapped in a bow.`,
  },

  // ── lessons_learned — Lessons Learned ─────────────────────────────────────
  lessons_learned: {
    slug: 'lessons_learned',
    goal: 'trust',
    acceptsCtaIntent: true,
    includeCraftRules: true,
    allowEnumeration: false,
    inputLabel: '',
    maxTokens: 1500,
    structureGuide: `This is a LESSONS LEARNED post: turn one real experience into a single sharp, earned lesson.
Move through: a reflective or surprising opening that signals a lesson is coming; the scenario, told plainly; the obstacle or what went wrong; the insight or belief shift it produced; and how it changed the author's approach.
- Reflective over preachy. Vulnerable but professional. One sharp lesson, not a list of takeaways.
- Do not invent facts. If the shift is unstated, infer a modest one rather than inventing specifics.
State the lesson plainly and keep it grounded in the specific event — never a generic platitude, and never wrapped in an "and that's when I learned..." bow.`,
  },

  // ── bts — Behind the Scenes ────────────────────────────────────────────────
  bts: {
    slug: 'bts',
    goal: 'trust',
    acceptsCtaIntent: true,
    includeCraftRules: true,
    allowEnumeration: false,
    inputLabel: '',
    maxTokens: 1500,
    structureGuide: `This is a BEHIND-THE-SCENES post: show the work, thinking, and decisions behind the author's results — NOT a personal story.
- Do NOT use a narrative or life-story arc, emotional storytelling, or vulnerability framing.
- Focus on process, decisions, constraints, and what was happening in real time. Write as if showing work-in-progress to a peer.
- Any insight should emerge implicitly from the process, not as a stated moral or lesson.
Move through: a transparent, curiosity-pulling opening; the project or moment; what was hard, messy, or unexpected; what shifted; and a crisp process insight the reader can use.`,
  },

  // ── contrarian — Contrarian / Hot Take ────────────────────────────────────
  contrarian: {
    slug: 'contrarian',
    goal: 'reach',
    acceptsCtaIntent: false,
    includeCraftRules: true,
    allowEnumeration: false,
    inputLabel: '',
    maxTokens: 1500,
    structureGuide: `This is a CONTRARIAN / HOT TAKE post: challenge a mainstream belief and position the author as an original thinker.
Move through: a sharp, pattern-breaking opening; the common belief or myth the audience holds; the author's counter-position, stated confidently; the logic, observation, or experience that proves it; and what it means for how the reader should think or act.
- Bold but professional. Grounded in real reasoning, not just provocative. Never invent supporting claims.
Close with ONE question that forces readers to take a side — a real disagreement people will publicly argue over ("Hot take: [the post's position]. Where am I wrong?" or "Most people think X. I think Y. Who's right?"). Seven people arguing in the replies beats seventy nodding. Never a generic "What do you think?".`,
  },

  // ── framework — Framework / How-To ────────────────────────────────────────
  framework: {
    slug: 'framework',
    goal: 'save',
    acceptsCtaIntent: false,
    includeCraftRules: true,
    allowEnumeration: true,
    inputLabel: '',
    maxTokens: 1500,
    structureGuide: `This is a FRAMEWORK / HOW-TO post: simplify a complex idea into clear, actionable steps.
Move through: a clear promise or unexpected lesson as the opening; why it matters for the audience; a clean 3–5 step framework where each step is practical and skimmable; an optional short example; and one closing belief shift.
- Teach with clarity and high practical value. One strong lesson, applied.
A numbered or dashed list is the right format here — enumerate the steps freely. Vary the length and phrasing of steps so they read hand-written, not templated.
Close with one specific, open-ended question that makes readers want to share their own experience. Never a generic "What do you think?".`,
  },

  // ── announcement — Wishes / Gratitude / Greetings ─────────────────────────
  announcement: {
    slug: 'announcement',
    goal: 'reach',
    acceptsCtaIntent: false,
    includeCraftRules: false, // goodwill posts have no scroll-hook or POV
    allowEnumeration: false,
    inputLabel: 'OCCASION / MESSAGE:',
    maxTokens: 1000,
    structureGuide: `This is a GOODWILL post: wishes, gratitude, greetings, or appreciation. Social goodwill only.
- Do NOT teach, explain, advise, tell a life story, or include lessons, frameworks, offers, or calls to action.
- Do NOT sell, pitch, invite, or direct the reader to do anything.
- Focus only on acknowledgement, gratitude, appreciation, or well-wishing.
- Warm, genuine, professional. Simple conversational language. No hype or exaggerated emotion. Write as a real person addressing their network.
Keep it short: roughly 60–120 words, short paragraphs, effortless to read on mobile.`,
  },

  // ── lead_gen — Lead Gen Offer ─────────────────────────────────────────────
  lead_gen: {
    slug: 'lead_gen',
    goal: 'convert',
    acceptsCtaIntent: false, // soft CTA is baked into the structure
    includeCraftRules: true,
    allowEnumeration: false,
    inputLabel: '',
    maxTokens: 1500,
    structureGuide: `This is a LEAD GEN OFFER post: a subtle, value-first invitation that builds trust while gently guiding the reader toward an offer or next step.
Move through: a problem- or desire-aware opening; the pain, shown with empathy; a genuinely useful insight or preview (valuable even if they never take the offer); a soft, low-pressure introduction of the offer; and a warm, optional invitation.
- Value first. The invitation must feel optional, never pressured. Preserve trust.
Keep the CTA soft — e.g. "If you want the full breakdown, drop a comment." or "If you'd like access, the link's in the first comment." No aggressive pitch. The CTA is the final line.`,
  },

  // ── pis — Problem → Insight → Solution ────────────────────────────────────
  pis: {
    slug: 'pis',
    goal: 'trust',
    acceptsCtaIntent: false, // PIS posts close without a CTA
    includeCraftRules: true,
    allowEnumeration: false,
    inputLabel: 'POST CONTENT:',
    maxTokens: 1500,
    structureGuide: `This is a PROBLEM → INSIGHT → SOLUTION post: diagnose a problem, reveal a non-obvious cause, and offer a simple, credible resolution.
Move through: a sharp, problem-led opening naming the real problem the audience faces; why it's frustrating or costly; the deeper hidden cause or misconception (use the cause given in the input — do NOT invent one if none is provided); a simple, believable resolution (a short framework, a few principles, or a model); and what changes once it's applied.
- Clear over clever. Specific over abstract. Expert over motivational.
- Deliver a belief shift, grounded only in what the input supports.
End without a call to action.`,
  },

  // ── results — Results / Case Study ────────────────────────────────────────
  results: {
    slug: 'results',
    goal: 'convert',
    acceptsCtaIntent: true,
    includeCraftRules: true,
    allowEnumeration: false,
    inputLabel: '',
    maxTokens: 1500,
    structureGuide: `This is a RESULTS / CASE STUDY post: turn a real outcome into credibility that makes the reader think "that could be me too".
Move through: a hook that leads with the result — a number, a before/after contrast, or a milestone (specific, not generic); a brief "before" that sets up the contrast; the mechanism or decision that drove the result (the "how" builds credibility — include only if given); one clear insight the result proves; and, if given, a line signalling who can relate.
- Specific over vague. Credible over hypey. Earned over boastful. Show the mechanism, not "I just worked hard".
- NEVER invent numbers, data, or outcomes not in the input. If no number is given, lead with the concrete before/after change itself — do not fabricate a figure.`,
  },
};

function getRecipe(slug) {
  return RECIPES[slug] || null;
}

module.exports = { RECIPES, getRecipe };

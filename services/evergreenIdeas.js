'use strict';

/**
 * services/evergreenIdeas.js — Tier-0 idea supply (the floor of the ladder).
 *
 * ~40 consultant-post scaffolds that work for any niche. Interpolated with the
 * user's niche/audience/pillar at serve time — no LLM call required, so this
 * tier can never fail or cost tokens. See idea-engine-spec-2026.md (R2, T0).
 *
 * Placeholders: {{niche}}, {{audience}}, {{pillar}}
 * Fallbacks applied in interpolate() when the profile lacks a value.
 */

const EVERGREEN_IDEAS = [
  // ── REACH — relatable stories, contradictions, lessons ────────────────────
  { slug: 'advice-younger-self', post_type: 'reach', title: 'Advice to your younger self',
    hook: "If I could go back to my first year in {{niche}}, I'd ignore almost everything I was told.",
    input: "The advice I'd give myself when I started in {{niche}}: what everyone told me to do, what actually worked with {{audience}}, and one belief I had to abandon." },
  { slug: 'client-fired-lesson', post_type: 'reach', title: 'The client you lost — and what it taught you',
    hook: "Losing a client taught me more about {{niche}} than any win ever did.",
    input: "A story about a client engagement that ended badly or early, what I misread, and the rule I follow now because of it." },
  { slug: 'unpopular-habit', post_type: 'reach', title: 'A work habit people find strange',
    hook: "I do one thing every week that most people in {{niche}} would call a waste of time.",
    input: "A habit or ritual in my {{niche}} work that looks unproductive from the outside but drives my best results — what it is and why it works." },
  { slug: 'biggest-early-mistake', post_type: 'reach', title: 'Your most expensive early mistake',
    hook: "My most expensive mistake in {{niche}} cost me months — and it looked like the smart move at the time.",
    input: "The biggest mistake I made early in my {{niche}} career: what I chose, why it seemed right, what it actually cost, and what I do differently now." },
  { slug: 'before-after-belief', post_type: 'reach', title: 'A belief you reversed',
    hook: "Five years ago I argued the exact opposite of what I'm about to say.",
    input: "Something I used to firmly believe about {{niche}} that I now think is wrong — what changed my mind, with the specific moment or project that did it." },
  { slug: 'day-everything-clicked', post_type: 'reach', title: 'The day it clicked',
    hook: "For years I was doing {{niche}} the hard way. Then one conversation changed how I work.",
    input: "The moment my approach to {{niche}} fundamentally changed — the conversation, project, or failure that triggered it and what shifted afterward." },
  { slug: 'what-nobody-warns', post_type: 'reach', title: 'What nobody warns you about',
    hook: "Nobody warns you about the hardest part of working in {{niche}}. It isn't the work.",
    input: "The part of {{niche}} work that surprised me most — the thing nobody mentions when you start, and how I learned to handle it." },
  { slug: 'said-no-to-money', post_type: 'reach', title: 'The project you turned down',
    hook: "I turned down a well-paying project last year. It was the easiest decision I've made in {{niche}}.",
    input: "A story about turning down revenue — the project or client, the red flag I saw, and why saying no protected my business (or sanity)." },
  { slug: 'ordinary-moment-insight', post_type: 'reach', title: 'An everyday moment that mirrors your work',
    hook: "Something happened outside work this week that explains {{niche}} better than any framework I know.",
    input: "An everyday, non-work moment (with family, travel, a hobby) that unexpectedly mirrors a truth about {{niche}} — the moment and the parallel." },
  { slug: 'career-detour', post_type: 'reach', title: 'The detour that made you better',
    hook: "The least relevant job on my CV made me better at {{niche}} than any qualification.",
    input: "A past role, industry, or experience that looks unrelated to {{niche}} but shaped how I serve {{audience}} — the specific skill or lens it gave me." },
  { slug: 'still-hard', post_type: 'reach', title: 'What is still hard after all these years',
    hook: "After years in {{niche}}, one part of the job still doesn't get easier.",
    input: "The part of {{niche}} work that experience hasn't made easier for me, why I've stopped expecting it to, and how I manage it anyway." },
  { slug: 'proud-unseen-work', post_type: 'reach', title: 'Work you are proud of that nobody sees',
    hook: "The work I'm most proud of never shows up in a case study.",
    input: "Behind-the-scenes work in {{niche}} that clients never see but that makes the visible results possible — what it is and why I keep investing in it." },

  // ── TRUST — non-obvious insights, myths, contrarian expertise ─────────────
  { slug: 'industry-myth', post_type: 'trust', title: 'The myth your industry repeats',
    hook: "There's advice in {{niche}} that gets repeated everywhere — and it quietly hurts {{audience}}.",
    input: "A widely repeated piece of {{niche}} advice I think is wrong or oversimplified: what people say, why it fails in practice, and what I recommend instead." },
  { slug: 'question-clients-should-ask', post_type: 'trust', title: 'The question clients never ask (but should)',
    hook: "In every first meeting, {{audience}} ask me the same questions. The most important one never comes up.",
    input: "The question {{audience}} should ask before hiring anyone in {{niche}} but almost never do — why it matters and what the answer reveals." },
  { slug: 'signal-vs-noise', post_type: 'trust', title: 'What actually predicts success',
    hook: "Most {{audience}} track the wrong signals in {{niche}}. The one that matters is far less glamorous.",
    input: "The metric or signal in {{niche}} everyone obsesses over vs. the unglamorous one that actually predicts results — with an example from my work." },
  { slug: 'why-diy-fails', post_type: 'trust', title: 'Why the DIY approach stalls',
    hook: "{{audience}} usually try to handle {{pillar}} themselves first. Here's exactly where that breaks down.",
    input: "The predictable point where {{audience}} doing {{pillar}} on their own hits a wall — the specific failure pattern I keep seeing and why it happens." },
  { slug: 'first-thing-i-check', post_type: 'trust', title: 'The first thing you check',
    hook: "Give me ten minutes with any {{niche}} problem and I'll check one thing before anything else.",
    input: "The first diagnostic I run when a client brings me a {{niche}} problem — what it reveals and why most issues trace back to it." },
  { slug: 'expensive-vs-cheap-mistake', post_type: 'trust', title: 'The mistake hierarchy',
    hook: "In {{niche}}, some mistakes cost money. One kind costs the whole project.",
    input: "The difference between recoverable mistakes and fatal ones in {{niche}} — which errors I tell {{audience}} not to worry about, and the one I never let slide." },
  { slug: 'unpopular-opinion', post_type: 'trust', title: 'Your unpopular professional opinion',
    hook: "Unpopular opinion from someone who's spent years in {{niche}}: the industry has this backwards.",
    input: "My most contrarian professional stance in {{niche}} — what the mainstream view is, why I disagree, and the experience that formed my position." },
  { slug: 'jargon-translation', post_type: 'trust', title: 'Translate the jargon',
    hook: "{{niche}} has a term that confuses every client I meet. Let me translate it.",
    input: "A piece of {{niche}} jargon or a concept {{audience}} consistently misunderstand — what people think it means, what it actually means, and why the gap matters." },
  { slug: 'what-good-looks-like', post_type: 'trust', title: 'What good actually looks like',
    hook: "Most {{audience}} have never seen what good {{pillar}} actually looks like. So they settle.",
    input: "How {{audience}} can tell excellent {{pillar}} work from mediocre — the specific markers of quality most people don't know to look for." },
  { slug: 'pattern-across-clients', post_type: 'trust', title: 'The pattern across every client',
    hook: "After enough {{niche}} projects, you start seeing the same pattern everywhere.",
    input: "A pattern I see across almost every {{niche}} client — the recurring root cause behind seemingly different problems, and what it means for {{audience}}." },
  { slug: 'timing-truth', post_type: 'trust', title: 'When to act (and when to wait)',
    hook: "{{audience}} usually get the timing of {{pillar}} wrong — in both directions.",
    input: "When {{audience}} should invest in {{pillar}} vs. when it's genuinely too early — the readiness signals I look for before taking someone on." },
  { slug: 'tool-vs-thinking', post_type: 'trust', title: 'Tools do not fix thinking',
    hook: "Every month, {{audience}} ask me which tool to buy for {{pillar}}. It's almost never a tool problem.",
    input: "Why the popular tools in {{niche}} don't fix the underlying problem — what {{audience}} actually need to solve first, with an example." },

  // ── CONVERT — outcomes, client results, problem→solution ──────────────────
  { slug: 'objection-teardown', post_type: 'convert', title: 'The objection you hear weekly',
    hook: "Every week a potential client tells me the same reason they can't fix {{pillar}}. Every week it's wrong.",
    input: "The most common objection I hear from {{audience}} about addressing {{pillar}} — the exact words they use, why the concern is understandable but mistaken, and what happens when they move past it." },
  { slug: 'small-change-big-result', post_type: 'convert', title: 'Small change, outsized result',
    hook: "One small change delivered the biggest result a client got from me last year. It took less than a week.",
    input: "A specific small intervention in a {{niche}} engagement that produced an outsized result — what we changed, why it worked, and roughly what it was worth." },
  { slug: 'what-working-with-me-looks-like', post_type: 'convert', title: 'What working together actually looks like',
    hook: "{{audience}} often assume working with a {{niche}} consultant means big invoices and vague deliverables. Here's what actually happens.",
    input: "A walkthrough of my typical engagement: what the first week looks like, what I need from the client, and when they see the first tangible result." },
  { slug: 'cost-of-waiting', post_type: 'convert', title: 'The cost of doing nothing',
    hook: "The most expensive option for {{pillar}} isn't hiring help. It's another year of the status quo.",
    input: "What ignoring {{pillar}} actually costs {{audience}} — the hidden, compounding costs of inaction I've seen, with a concrete example or number." },
  { slug: 'who-i-cant-help', post_type: 'convert', title: 'Who you cannot help',
    hook: "I turn away a specific kind of {{niche}} client — and it's not about budget.",
    input: "Who I'm NOT the right fit for in {{niche}} and why — the honest criteria, which by contrast defines exactly who gets the best results with me." },
  { slug: 'diagnose-in-comments', post_type: 'convert', title: 'The 5-minute self-diagnosis',
    hook: "You can diagnose the biggest {{pillar}} problem in your business in five minutes. Here's how.",
    input: "A quick self-assessment {{audience}} can run on their own {{pillar}} situation — 3-4 questions to ask, what each answer reveals, and the threshold where it's time to get help." },
  { slug: 'transformation-timeline', post_type: 'convert', title: 'The realistic timeline',
    hook: "\"How long until we see results?\" Here's the honest {{niche}} answer nobody gives you.",
    input: "The realistic timeline for results in {{pillar}} — what changes in the first month, the first quarter, and the first year, based on my actual client work." },
  { slug: 'red-flags-when-hiring', post_type: 'convert', title: 'Red flags when hiring in your field',
    hook: "If a {{niche}} consultant says this in a sales call, walk away.",
    input: "The red flags {{audience}} should watch for when hiring in {{niche}} — the promises or patterns that signal trouble, and what credible looks like instead." },
  { slug: 'result-nobody-expected', post_type: 'convert', title: 'The side-effect result',
    hook: "A client hired me for one problem. The biggest result came from somewhere we weren't even looking.",
    input: "An engagement where the most valuable outcome wasn't the one the client hired me for — what we found along the way and what it changed for them." },

  // ── LEAD MAGNET — giveaways, checklists, frameworks ───────────────────────
  { slug: 'checklist-giveaway', post_type: 'lead_magnet', title: 'Your pre-engagement checklist',
    hook: "I run the same checklist at the start of every {{niche}} engagement. Want it?",
    input: "Offer my standard {{pillar}} checklist as a giveaway — what it covers, the mistake it prevents, and why I use it on every single project." },
  { slug: 'questions-doc', post_type: 'lead_magnet', title: 'The questions that surface everything',
    hook: "I ask new clients the same set of questions — and they surface problems the client didn't know they had.",
    input: "Offer my client intake / discovery question set for {{niche}} — what the questions uncover and one surprising thing they revealed recently." },
  { slug: 'mistakes-guide', post_type: 'lead_magnet', title: 'The mistakes compilation',
    hook: "I've watched {{audience}} make the same {{pillar}} mistakes for years. I finally wrote them all down.",
    input: "Offer a short guide to the most common {{pillar}} mistakes {{audience}} make — the top 3 it covers and what avoiding just one of them is worth." },
  { slug: 'template-share', post_type: 'lead_magnet', title: 'The template you actually use',
    hook: "This is the exact template I use for {{pillar}} with paying clients. I'm giving it away.",
    input: "Offer a working template/framework from my {{niche}} practice — what it's for, how long it took to refine, and the result it consistently produces." },
  { slug: 'teardown-offer', post_type: 'lead_magnet', title: 'The free teardown',
    hook: "Comment below and I'll take a look at your {{pillar}} — no pitch, just honest feedback.",
    input: "Offer a limited free review/teardown of {{audience}}'s {{pillar}} situation — what I'll look at, what they'll walk away knowing, and the simple way to claim it." },
  { slug: 'resource-stack', post_type: 'lead_magnet', title: 'Your professional toolkit',
    hook: "People keep asking which tools and resources I actually use for {{niche}}. Here's the full list.",
    input: "Offer my curated toolkit/resource list for {{pillar}} — the categories it covers and the one resource in it almost nobody knows about." },
];

// ---------------------------------------------------------------------------
// Daily questions (Idea Engine R4 — the question-card variant).
// Served when vault supply is thin: a 30-second answer becomes both a vault
// memory and a post seed. Questions ask about RECENT, SPECIFIC experience —
// things anyone actively working can answer without thinking hard.
// ---------------------------------------------------------------------------
const DAILY_QUESTIONS = [
  { slug: 'q-client-pushback',    post_type: 'trust',   question: 'What did a client push back on this week — and were they right?' },
  { slug: 'q-common-question',    post_type: 'trust',   question: 'What question did {{audience}} ask you most recently? How did you answer it?' },
  { slug: 'q-explained-twice',    post_type: 'trust',   question: 'What did you have to explain twice this week? Why do you think it didn\'t land the first time?' },
  { slug: 'q-changed-mind',       post_type: 'reach',   question: 'What have you changed your mind about in {{niche}} recently — even slightly?' },
  { slug: 'q-client-surprise',    post_type: 'reach',   question: 'When did a client last surprise you? What happened?' },
  { slug: 'q-small-win',          post_type: 'convert', question: 'What small win did a client get this week (or month) because of your work?' },
  { slug: 'q-repeated-mistake',   post_type: 'trust',   question: 'What mistake do you keep seeing {{audience}} make with {{pillar}}?' },
  { slug: 'q-proud-number',       post_type: 'convert', question: 'What number from your work are you quietly proud of right now?' },
  { slug: 'q-universal-advice',   post_type: 'trust',   question: 'What advice did you give recently that applies to almost every client you have?' },
  { slug: 'q-process-misread',    post_type: 'reach',   question: 'What part of how you work do clients most misunderstand at the start?' },
  { slug: 'q-said-no',            post_type: 'convert', question: 'What did you say no to recently — a request, a project, a shortcut? Why?' },
  { slug: 'q-industry-annoyance', post_type: 'trust',   question: 'What\'s something happening in {{niche}} right now that quietly annoys you?' },
  { slug: 'q-before-after',       post_type: 'convert', question: 'Think of your longest-running client: what\'s the biggest difference between their day one and now?' },
  { slug: 'q-tool-or-habit',      post_type: 'reach',   question: 'What tool or habit did you rely on this week that most {{audience}} don\'t use?' },
  { slug: 'q-hard-conversation',  post_type: 'reach',   question: 'What was the hardest conversation you had at work recently — and what made it worth having?' },
  { slug: 'q-first-hour',         post_type: 'trust',   question: 'When you start with a new client, what do you look at in the first hour that others skip?' },
];

// pickDailyQuestion({ postType, excludeSlugs }) → one interpolated question card seed
function pickDailyQuestion({ postType = null, excludeSlugs = [] } = {}) {
  const excluded = new Set(excludeSlugs);
  let pool = DAILY_QUESTIONS.filter(q => !excluded.has(q.slug));
  if (!pool.length) pool = DAILY_QUESTIONS;
  const preferred = postType ? pool.filter(q => q.post_type === postType) : [];
  const ordered = [...preferred, ...pool.filter(q => !preferred.includes(q))];
  const dayOfYear = Math.floor((Date.now() - Date.parse(new Date().getFullYear() + '-01-01')) / 86400000);
  return ordered[dayOfYear % ordered.length];
}

// ---------------------------------------------------------------------------
// interpolate(idea, profile) → { hook, input, title }
// Replaces {{niche}}/{{audience}}/{{pillar}} with profile values (graceful
// fallbacks keep the copy readable when the profile is thin).
// ---------------------------------------------------------------------------
function fillTemplate(s, { niche, audience, pillar } = {}) {
  // Fallbacks must read naturally in BOTH noun-phrase slots ("template for X")
  // and adjectival slots ("the same X mistakes") — 'client work' survives both.
  const vals = {
    niche:    (niche    || 'my field').trim(),
    audience: (audience || 'clients').trim(),
    pillar:   (pillar   || niche || 'client work').trim(),
  };
  return s
    .replace(/\{\{niche\}\}/g, vals.niche)
    .replace(/\{\{audience\}\}/g, vals.audience)
    .replace(/\{\{pillar\}\}/g, vals.pillar);
}

function interpolate(idea, vals = {}) {
  return { title: idea.title, hook: fillTemplate(idea.hook, vals), input: fillTemplate(idea.input, vals) };
}

// ---------------------------------------------------------------------------
// pickEvergreen({ count, postType, excludeSlugs }) → idea rows (uninterpolated)
// Deterministic-ish variety: filters exclusions first, prefers postType match,
// then rotates by day-of-year so consecutive days don't repeat.
// ---------------------------------------------------------------------------
function pickEvergreen({ count = 1, postType = null, excludeSlugs = [] } = {}) {
  const excluded = new Set(excludeSlugs);
  let pool = EVERGREEN_IDEAS.filter(i => !excluded.has(i.slug));
  if (!pool.length) pool = EVERGREEN_IDEAS; // every slug used — allow repeats rather than starve

  const preferred = postType ? pool.filter(i => i.post_type === postType) : [];
  const ordered = [...preferred, ...pool.filter(i => !preferred.includes(i))];

  // Rotate by day-of-year so the same user gets different scaffolds day to day.
  const dayOfYear = Math.floor((Date.now() - Date.parse(new Date().getFullYear() + '-01-01')) / 86400000);
  const offset = dayOfYear % ordered.length;
  const rotated = [...ordered.slice(offset), ...ordered.slice(0, offset)];

  return rotated.slice(0, count);
}

module.exports = { EVERGREEN_IDEAS, DAILY_QUESTIONS, interpolate, fillTemplate, pickEvergreen, pickDailyQuestion };

'use strict';

/**
 * services/ideaEngine.js — "Today's 3" supply ladder resolver.
 * Spec: idea-engine-spec-2026.md (R1/R2/R5). Sprint: sprint-idea-engine-phase1.md.
 *
 * getDailyCards() walks the supply ladder and serves 3 idea cards per user per day:
 *   T3 — fresh vault_ideas with a hook_preview (capped at 2/day so one slot always
 *        brings variety from lower tiers, and to leave room for the daily-question
 *        card variant in P1)
 *   T2 — sequel to the user's top-performing recent post (needs one LLM call,
 *        shared with T1)
 *   T1 — profile-grounded ideas (positioning, pillars, audience) — same substance
 *        context as /api/vault/suggest-topics
 *   T0 — evergreen consultant scaffolds, interpolated locally (never fails,
 *        costs nothing)
 *
 * Cards are generated on the first request of the day and cached in idea_cards.
 * Dedup rules: a vault_idea is never served twice; evergreen slugs don't repeat
 * within 60 days; recent titles are passed to the LLM as exclusions.
 */

const { db, getSetting } = require('../db');
const { interpolate, fillTemplate, pickEvergreen, pickDailyQuestion } = require('./evergreenIdeas');

const SONNET_MODEL = 'claude-sonnet-5';
const T3_DAILY_CAP = 2;
const CARDS_PER_DAY = 3;

// ---------------------------------------------------------------------------
// Static extraction questions — the floor for cards the LLM call didn't write
// (evergreen T0, or any tier when the call is skipped/failed). Same shape the
// LLM path produces, so the generate.html 2-question flow treats them alike.
// Q1 (moment) pulls the real situation behind the idea; Q2 (proof) pulls a
// number / outcome. See migrations/073.
// ---------------------------------------------------------------------------
const STATIC_QUESTION_ITEMS = {
  reach: [
    { key: 'moment', q: "What's the real moment behind this — a specific client, conversation, or day it happened?", help: 'One specific scene, in plain words.' },
    { key: 'proof',  q: 'What detail makes it land — a number, a timeframe, or what changed afterward?', help: 'A concrete number or outcome makes it credible.' },
  ],
  trust: [
    { key: 'moment', q: 'Where have you seen this play out in your own work — who was involved and what happened?', help: 'A real situation you can point to.' },
    { key: 'proof',  q: "What's your evidence — a result, a pattern you keep seeing, or a before/after you observed?", help: 'Specifics beat generic claims.' },
  ],
  convert: [
    { key: 'moment', q: 'Which client or project is this really about — what was going on before you stepped in?', help: 'The starting situation, concretely.' },
    { key: 'proof',  q: "What was the measurable outcome — a number, %, timeframe, or the client's own words?", help: 'The harder the number, the better.' },
  ],
  lead_magnet: [
    { key: 'moment', q: "Who is this for, and what specific problem were they stuck on when they came to you?", help: 'A real person or situation, not a persona.' },
    { key: 'proof',  q: 'What changed once you helped — a result, timeframe, or exact words they used?', help: 'Concrete proof earns the click.' },
  ],
};

function staticQuestions(postType) {
  const items = STATIC_QUESTION_ITEMS[postType] || STATIC_QUESTION_ITEMS.reach;
  return { v: 1, source: 'static', items: items.map(i => ({ ...i })) };
}

// ---------------------------------------------------------------------------
// Profile context (same shape the vault mining/suggest-topics paths use)
// ---------------------------------------------------------------------------
async function fetchIdeaProfile(tenantId) {
  return db.prepare(`
    SELECT p.content_pillars, p.input_examples,
           p.voice_fingerprint, p.authority_statements,
           bvp.brand_industry, bvp.elevator_main_result, bvp.brand_core_beliefs,
           ap.audience_description, ap.audience_obstacles
    FROM profiles p
    LEFT JOIN brand_voice_profiles bvp ON bvp.profile_id = p.id
    LEFT JOIN audience_profiles ap ON ap.profile_id = p.id
    WHERE p.workspace_id = ? AND p.is_default = true
  `).get(tenantId);
}

// Voice fingerprint positioning + authority proof points — the strongest signal
// for grounding cards (and their questions) in what this consultant actually
// stands for. Same JSON shapes routes/generate.js chat-intake parses.
function parseVoiceContext(profile) {
  let positioning = {};
  try {
    const fp = JSON.parse(profile?.voice_fingerprint || '{}');
    positioning = (fp && typeof fp.positioning === 'object') ? fp.positioning : {};
  } catch { positioning = {}; }
  let authorityStatements = [];
  try {
    const arr = JSON.parse(profile?.authority_statements || '[]');
    authorityStatements = Array.isArray(arr) ? arr.filter(s => typeof s === 'string' && s.trim()).slice(0, 2) : [];
  } catch { authorityStatements = []; }
  return {
    standsFor: (positioning.stands_for || '').trim(),
    outcome:   (positioning.outcome || '').trim(),
    authorityStatements,
  };
}

// Last few published posts (topic + performance) — lets the LLM extend what's
// landed and steer clear of what hasn't.
async function fetchRecentPublishedPosts(tenantId) {
  try {
    const rows = await db.prepare(`
      SELECT content, post_type, performance_tag
      FROM   generated_posts
      WHERE  tenant_id = ? AND status = 'published' AND published_at IS NOT NULL
      ORDER  BY published_at DESC
      LIMIT  5
    `).all(tenantId);
    return rows.map(r => ({
      topic: String(r.content || '').split('\n')[0].trim().slice(0, 120),
      post_type: r.post_type || null,
      performance: r.performance_tag || null,
    })).filter(r => r.topic);
  } catch { return []; }
}

// The consultant's own answers to daily questions — real first-person material,
// the best raw signal for personalising extraction questions.
async function fetchAnsweredQuestions(tenantId) {
  try {
    const rows = await db.prepare(`
      SELECT seed_text, source_ref
      FROM   vault_ideas
      WHERE  tenant_id = ? AND source = 'daily_question'
        AND  seed_text IS NOT NULL AND seed_text <> ''
      ORDER  BY created_at DESC
      LIMIT  5
    `).all(tenantId);
    return rows.map(r => ({
      // source_ref is stored as: You answered: "<hook>"
      prompt: String(r.source_ref || '').replace(/^You answered:\s*/i, '').replace(/^"|"$/g, '').slice(0, 160),
      answer: String(r.seed_text || '').trim().slice(0, 300),
    })).filter(r => r.answer);
  } catch { return []; }
}

function parsePillars(profile) {
  try {
    const parsed = JSON.parse(profile?.content_pillars || '[]');
    return Array.isArray(parsed) ? parsed.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim()) : [];
  } catch { return []; }
}

// Short interpolation values for evergreen templates — a full audience sentence
// reads badly mid-hook, so fall back to a generic word past 50 chars.
function evergreenVals(profile, pillars) {
  const audience = (profile?.audience_description || '').trim();
  return {
    niche:    (profile?.brand_industry || '').trim() || null,
    audience: audience && audience.length <= 50 ? audience : null,
    pillar:   pillars[0] || null,
  };
}

// ---------------------------------------------------------------------------
// Mix recommendation (same 50/30/20 logic as GET /api/posts/mix-recommendation)
// ---------------------------------------------------------------------------
async function getRecommendedType(tenantId) {
  try {
    const rows = await db.prepare(`
      SELECT post_type, COUNT(*) AS n
      FROM   generated_posts
      WHERE  tenant_id = ?
        AND  status = 'published'
        AND  post_type IN ('reach', 'trust', 'convert')
        AND  published_at > NOW() - INTERVAL '30 days'
      GROUP  BY post_type
    `).all(tenantId);
    const total = rows.reduce((s, r) => s + Number(r.n), 0);
    if (total < 4) return 'reach';
    const counts = { reach: 0, trust: 0, convert: 0 };
    for (const row of rows) counts[row.post_type] = Number(row.n);
    const targets = { reach: 0.50, trust: 0.30, convert: 0.20 };
    let worstType = 'reach', worstDelta = -Infinity;
    for (const [type, target] of Object.entries(targets)) {
      const delta = target - counts[type] / total;
      if (delta > worstDelta) { worstDelta = delta; worstType = type; }
    }
    return worstType;
  } catch { return 'reach'; }
}

// ---------------------------------------------------------------------------
// Dedup memory
// ---------------------------------------------------------------------------
async function fetchServedHistory(tenantId) {
  const rows = await db.prepare(`
    SELECT title, hook, provenance_ref, served_on, status
    FROM   idea_cards
    WHERE  tenant_id = ?
      AND  served_on > CURRENT_DATE - INTERVAL '60 days'
    ORDER  BY served_on DESC
  `).all(tenantId);

  const usedVaultIdeaIds = new Set();
  const usedInsightIds = new Set();
  const usedEvergreenSlugs = new Set();
  const usedPostRefs = new Set();
  const usedQuestionSlugs = new Set();
  const recentTitles = [];
  const savedHooks = [];     // acted on — positive taste signal
  const dismissedHooks = []; // rejected — negative taste signal
  for (const r of rows) {
    if (r.provenance_ref?.startsWith('vault_idea:'))    usedVaultIdeaIds.add(Number(r.provenance_ref.slice(11)));
    if (r.provenance_ref?.startsWith('vault_insight:')) usedInsightIds.add(Number(r.provenance_ref.slice(14)));
    if (r.provenance_ref?.startsWith('evergreen:'))  usedEvergreenSlugs.add(r.provenance_ref.slice(10));
    if (r.provenance_ref?.startsWith('post:'))       usedPostRefs.add(r.provenance_ref);
    if (r.provenance_ref?.startsWith('question:'))   usedQuestionSlugs.add(r.provenance_ref.slice(9));
    if (r.title) recentTitles.push(r.title);
    if (r.hook) {
      if ((r.status === 'saved' || r.status === 'generated') && savedHooks.length < 5) savedHooks.push(r.hook);
      else if (r.status === 'dismissed' && dismissedHooks.length < 5) dismissedHooks.push(r.hook);
    }
  }
  return { usedVaultIdeaIds, usedInsightIds, usedEvergreenSlugs, usedPostRefs, usedQuestionSlugs, recentTitles, savedHooks, dismissedHooks };
}

// ---------------------------------------------------------------------------
// T3 — vault ideas (hook already written by the fire-and-forget Haiku pass)
// ---------------------------------------------------------------------------
async function pickVaultCards(tenantId, recommendedType, usedVaultIdeaIds, cap = T3_DAILY_CAP) {
  if (cap <= 0) return [];
  // Fix #2 (vault consolidation): document material now reaches generation via
  // vault_insights (anchored to an LLM slot), so legacy DOCUMENT-MINED vault_ideas
  // are no longer served here — they'd double-dip the same documents and crowd
  // out the insight path. Kept: idea_engine suggestions, auto_extracted facts,
  // and daily_question answers (all documentless, the user's own material).
  const rows = await db.prepare(`
    SELECT vi.id, vi.seed_text, vi.funnel_type, vi.hook_preview, vd.filename
    FROM   vault_ideas vi
    LEFT   JOIN vault_documents vd ON vd.id = vi.document_id
    WHERE  vi.tenant_id = ?
      AND  vi.status = 'fresh'
      AND  vi.hook_preview IS NOT NULL AND vi.hook_preview <> ''
      AND  vi.document_id IS NULL
    ORDER  BY (vi.funnel_type = ?) DESC, vi.created_at DESC
    LIMIT  20
  `).all(tenantId, recommendedType);

  // Quality gate: hook must be substantive (7+ words) and not a placeholder.
  const qualityCheck = (hook) => {
    const words = String(hook || '').trim().split(/\s+/).length;
    const isPlaceholder = String(hook || '').match(/\{\{|placeholder|TODO|FILL|INSERT/i);
    return words >= 7 && !isPlaceholder;
  };

  // Semantic dedup: if two hooks start with the same 5+ words, skip the second.
  const seen = new Set();
  const semanticDedup = (hook) => {
    const prefix = String(hook || '')
      .trim()
      .split(/\s+/)
      .slice(0, 5)
      .join(' ')
      .toLowerCase();
    if (seen.has(prefix)) return false;
    seen.add(prefix);
    return true;
  };

  // Label: document-mined ideas cite the file; idea-engine rows (no document)
  // get a generic vault label — their source_ref holds a rationale, not a name.
  return rows
    .filter(r => !usedVaultIdeaIds.has(Number(r.id)) && qualityCheck(r.hook_preview) && semanticDedup(r.hook_preview))
    .slice(0, cap)
    .map(r => ({
      tier: 3,
      title: null,
      hook: r.hook_preview,
      textarea_input: r.seed_text,
      post_type: ['reach', 'trust', 'convert', 'lead_magnet'].includes(r.funnel_type) ? r.funnel_type : recommendedType,
      provenance_ref: `vault_idea:${r.id}`,
      provenance_label: r.filename ? `From your doc: ${String(r.filename).slice(0, 70)}` : 'From your content vault',
      is_question: false,
    }));
}

// ---------------------------------------------------------------------------
// T2 seed — the user's strongest recent post (sequel material for the LLM call)
// ---------------------------------------------------------------------------
async function pickSequelSeed(tenantId, usedPostRefs) {
  const rows = await db.prepare(`
    SELECT id, content, post_type
    FROM   generated_posts
    WHERE  tenant_id = ?
      AND  performance_tag = 'strong'
      AND  published_at > NOW() - INTERVAL '60 days'
    ORDER  BY published_at DESC
    LIMIT  5
  `).all(tenantId);
  return rows.find(r => !usedPostRefs.has(`post:${r.id}`)) || null;
}

// ---------------------------------------------------------------------------
// Anchor insight — one document insight to ground a single LLM card slot
// (mirrors pickSequelSeed). Least-recently-used first so the vault rotates
// through its material rather than repeating the same insight; skips insights
// already anchored in the last 60 days. Cheap SQL, no LLM.
// ---------------------------------------------------------------------------
async function fetchAnchorInsight(tenantId, usedInsightIds) {
  const rows = await db.prepare(`
    SELECT vi.id, vi.category, vi.content, vd.filename
    FROM   vault_insights vi
    LEFT   JOIN vault_documents vd ON vd.id = vi.document_id
    WHERE  vi.tenant_id = ?
    ORDER  BY vi.last_used_at ASC NULLS FIRST, vi.used_count ASC, vi.created_at DESC
    LIMIT  10
  `).all(tenantId);
  return rows.find(r => !usedInsightIds.has(Number(r.id))) || null;
}

// Fire-and-forget: record that an insight was fed to generation (rotation signal).
function bumpInsightUsage(insightId, tenantId) {
  Promise.resolve(
    db.prepare(
      'UPDATE vault_insights SET used_count = used_count + 1, last_used_at = now() WHERE id = ? AND tenant_id = ?'
    ).run(insightId, tenantId)
  ).catch(err => console.error('[ideaEngine] bumpInsightUsage failed (non-fatal):', err.message));
}

// Structured-output schema for the daily card+questions call. Object-length
// constraints aren't supported by json_schema, so counts are trimmed in code.
const IDEA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cards', 'preset_questions'],
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'hook', 'textarea_input', 'post_type', 'q_moment', 'q_proof'],
        properties: {
          title:          { type: 'string' },
          hook:           { type: 'string' },
          textarea_input: { type: 'string' },
          post_type:      { type: 'string', enum: ['reach', 'trust', 'convert'] },
          q_moment:       { type: 'string' },
          q_proof:        { type: 'string' },
        },
      },
    },
    preset_questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'q_moment', 'q_proof'],
        properties: {
          ref:      { type: 'string' },
          q_moment: { type: 'string' },
          q_proof:  { type: 'string' },
        },
      },
    },
  },
};

// Build a card's `questions` jsonb from an LLM q_moment/q_proof pair, falling
// back to the static per-type pair if either is missing.
function llmQuestions(postType, qMoment, qProof) {
  const m = typeof qMoment === 'string' ? qMoment.trim().slice(0, 200) : '';
  const p = typeof qProof === 'string' ? qProof.trim().slice(0, 200) : '';
  if (!m || !p) return staticQuestions(postType);
  return {
    v: 1,
    source: 'llm',
    items: [
      { key: 'moment', q: m, help: 'One specific moment, in plain words.' },
      { key: 'proof',  q: p, help: 'A concrete number or outcome makes it credible.' },
    ],
  };
}

// ---------------------------------------------------------------------------
// T2+T1 — one Sonnet call writes all remaining cards AND two extraction
// questions for every non-question card (including preset T3 vault cards, which
// it doesn't rewrite — it only writes their questions). Returns
// { cards, presetQuestions } where presetQuestions is keyed by ref.
// ---------------------------------------------------------------------------
async function generateLlmCardsAndQuestions({
  profile, pillars, recommendedType, sequelSeed, anchorInsight, recentTitles,
  voice, answeredQuestions, recentPosts, savedHooks, dismissedHooks,
  presetCards, count,
}) {
  const empty = { cards: [], presetQuestions: {} };
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) return empty;

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const context = [
    profile?.brand_industry        && `Niche: ${profile.brand_industry}`,
    profile?.audience_description  && `Audience: ${profile.audience_description}`,
    profile?.audience_obstacles    && `Audience's main challenge: ${profile.audience_obstacles}`,
    profile?.elevator_main_result  && `Positioning: ${profile.elevator_main_result}`,
    profile?.brand_core_beliefs    && `Their contrarian POV: ${profile.brand_core_beliefs}`,
    pillars.length                 && `Content pillars (stay within these): ${pillars.join(' · ')}`,
  ].filter(Boolean).join('\n');

  const voiceBlock = (voice && (voice.standsFor || voice.outcome || voice.authorityStatements.length))
    ? `\nVOICE & POSITIONING:\n${[
        voice.standsFor && `They stand for: ${voice.standsFor}`,
        voice.outcome   && `The outcome they deliver: ${voice.outcome}`,
        voice.authorityStatements.length && `Proof points: ${voice.authorityStatements.join('; ')}`,
      ].filter(Boolean).join('\n')}\n`
    : '';

  const answeredBlock = (answeredQuestions && answeredQuestions.length)
    ? `\nTHINGS THEY'VE ACTUALLY SAID (their real words — the strongest signal for grounding cards and personalising the questions):\n${answeredQuestions.map(a => `- Prompt: ${a.prompt || 'a daily question'}\n  They said: "${a.answer}"`).join('\n')}\n`
    : '';

  const postsBlock = (recentPosts && recentPosts.length)
    ? `\nRECENT PUBLISHED POSTS (topic — performance):\n${recentPosts.map(p => `- ${p.topic}${p.performance ? ` — ${p.performance}` : ''}`).join('\n')}\n`
    : '';

  const tasteBlock = ((savedHooks && savedHooks.length) || (dismissedHooks && dismissedHooks.length))
    ? `\nTASTE:\n${[
        savedHooks && savedHooks.length && `Hooks they saved or wrote from (lean into this style/angle):\n${savedHooks.map(h => `  + ${h}`).join('\n')}`,
        dismissedHooks && dismissedHooks.length && `Hooks they dismissed (avoid this style/angle):\n${dismissedHooks.map(h => `  - ${h}`).join('\n')}`,
      ].filter(Boolean).join('\n')}\n`
    : '';

  const sequelBlock = sequelSeed
    ? `\nThe FIRST idea must be a follow-up ("sequel") to this post, which was one of their best performers recently — extend the topic with a new angle, deeper detail, or the next logical question. Do NOT rehash it:\n"""${String(sequelSeed.content || '').slice(0, 600)}"""\n`
    : '';

  const presetBlock = (presetCards && presetCards.length)
    ? `\nPRESET CARDS (these are already written — do NOT rewrite them; only write their two questions, returned in "preset_questions" keyed by "ref"):\n${presetCards.map(p => `- ref: ${p.ref} — hook: "${p.hook}" (${p.post_type})`).join('\n')}\n`
    : '';

  // Anchor one card slot to a specific vault insight — the slot AFTER the sequel
  // (sequel owns idea #1 when present). Only when there's room. This grounds the
  // card in the author's own document without diluting the whole batch.
  const insightSlot = anchorInsight ? (sequelSeed ? 2 : 1) : 0; // 1-based; 0 = none
  const insightBlock = (insightSlot && insightSlot <= count)
    ? `\nIdea #${insightSlot} must be grounded in this specific material from the author's OWN document — build a post premise directly on it, staying faithful to what it says (do not contradict or generalise it away):\n"""${String(anchorInsight.content || '').slice(0, 500)}"""\n`
    : '';

  const message = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: 8000, // adaptive thinking (on by default for Sonnet 5) shares this budget
    output_config: { format: { type: 'json_schema', schema: IDEA_SCHEMA } },
    messages: [{
      role: 'user',
      content: `Generate ${count} LinkedIn post idea cards for this consultant, and for EVERY card write exactly two short questions the consultant answers before drafting.

CONSULTANT PROFILE:
${context}
${voiceBlock}${answeredBlock}${postsBlock}${tasteBlock}${sequelBlock}${insightBlock}${presetBlock}${recentTitles.length ? `\nDo NOT repeat any of these recently suggested angles:\n${recentTitles.slice(-30).map(t => `- ${t}`).join('\n')}\n` : ''}
CRITICAL: Each card MUST reveal something about THEIR work or their audience's challenges — never generic "how to scale" advice. Use this template:

REACH cards: A specific moment from your consulting work that shows how your audience is different, a client situation that surprised you, or a pattern you've seen repeatedly.
TRUST cards: A non-obvious insight or contrarian belief from serving your audience, a mistake you see them make, or a misunderstanding about your field.
CONVERT cards: A specific result you or a client achieved, a before/after that illustrates the impact of your work, or an unexpected obstacle you help people overcome.

Rules for every card:
- "hook" is the actual FIRST LINE of the post (≤ 2 sentences) — specific, grounded, no generic advice
- "textarea_input" is a 1–2 sentence SECOND-PERSON premise describing the angle the author could write about (e.g., "You've seen clients treat their email list like a megaphone" or "The gap most 6-figure creators hit is monetisation, not audience"). Do NOT write it as a first-person anecdote and do NOT invent specific numbers, named clients, or outcomes — those are the author's to supply in their answers. It is a prompt to react to, not a fact to repeat.
- "title" is a 3–7 word topic label
- "post_type" is one of reach|trust|convert — at least one must be "${recommendedType}"
- Each hook must pass this test: "Could I only write this based on my specific consulting experience?" If not, it's too generic.

QUESTION RULES (for every card, including the preset cards above):
- "q_moment" asks the consultant for the REAL moment behind this specific idea — a client, a conversation, a decision, or a day. Reference the card's hook concretely, and their real words above where they fit.
- "q_proof" asks for concrete proof — a number, a timeframe, a before/after, or the exact words someone used.
- Each question ≤ 140 characters, answerable in 1–3 sentences, written in second person ("you"), never a yes/no question.

Return a JSON object with "cards" (${count} objects: title, hook, textarea_input, post_type, q_moment, q_proof) and "preset_questions" (one object per preset ref: ref, q_moment, q_proof; empty array if no preset cards).`,
    }],
  });

  if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') return empty;

  // Sonnet 5 responses may lead with thinking blocks — read the text block.
  const text = (message.content.find(b => b.type === 'text') || {}).text || '{}';
  let parsed = {};
  try {
    const match = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : text);
  } catch { return empty; }

  const rawCards = Array.isArray(parsed.cards) ? parsed.cards : [];
  const cards = rawCards
    .filter(i => i && typeof i.hook === 'string' && i.hook.trim())
    .slice(0, count)
    .map((i, idx) => {
      const isSequel  = !!sequelSeed && idx === 0;
      // insightSlot is 1-based; the anchored card is at array index insightSlot-1.
      const isInsight = !isSequel && insightSlot > 0 && idx === insightSlot - 1;
      const postType = ['reach', 'trust', 'convert', 'lead_magnet'].includes(i.post_type) ? i.post_type : recommendedType;
      const docName = isInsight && anchorInsight.filename
        ? `From your doc: ${String(anchorInsight.filename).slice(0, 70)}`
        : 'From your content vault';
      return {
        tier: isSequel ? 2 : (isInsight ? 3 : 1),
        title: typeof i.title === 'string' ? i.title.slice(0, 120) : null,
        hook: i.hook.trim(),
        textarea_input: typeof i.textarea_input === 'string' ? i.textarea_input : '',
        post_type: postType,
        provenance_ref: isSequel ? `post:${sequelSeed.id}` : (isInsight ? `vault_insight:${anchorInsight.id}` : 'profile'),
        provenance_label: isSequel ? 'Sequel to your top post this month' : (isInsight ? docName : 'From your positioning'),
        is_question: false,
        questions: llmQuestions(postType, i.q_moment, i.q_proof),
      };
    });

  const presetQuestions = {};
  for (const pq of (Array.isArray(parsed.preset_questions) ? parsed.preset_questions : [])) {
    if (pq && typeof pq.ref === 'string') presetQuestions[pq.ref] = { qMoment: pq.q_moment, qProof: pq.q_proof };
  }

  return { cards, presetQuestions };
}

// ---------------------------------------------------------------------------
// T0 — evergreen fill (local, infallible)
// ---------------------------------------------------------------------------
function pickEvergreenCards({ count, recommendedType, usedEvergreenSlugs, profile, pillars }) {
  const vals = evergreenVals(profile, pillars);
  return pickEvergreen({ count, postType: recommendedType, excludeSlugs: [...usedEvergreenSlugs] })
    .map(idea => {
      const filled = interpolate(idea, vals);
      return {
        tier: 0,
        title: filled.title,
        hook: filled.hook,
        textarea_input: filled.input,
        post_type: idea.post_type,
        provenance_ref: `evergreen:${idea.slug}`,
        provenance_label: 'A proven consultant angle',
        is_question: false,
        questions: staticQuestions(idea.post_type),
      };
    });
}

// ---------------------------------------------------------------------------
// getDailyCards(userId, tenantId) → { cards, fresh }
// ---------------------------------------------------------------------------
async function getDailyCards(userId, tenantId) {
  const existing = await db.prepare(`
    SELECT id, hook, title, textarea_input, post_type, tier,
           provenance_ref, provenance_label, is_question, questions, status, served_on
    FROM   idea_cards
    WHERE  tenant_id = ? AND served_on = CURRENT_DATE
    ORDER  BY id
  `).all(tenantId);
  if (existing.length) return { cards: existing, fresh: false };

  const [profile, recommendedType, history, answeredQuestions, recentPosts] = await Promise.all([
    fetchIdeaProfile(tenantId),
    getRecommendedType(tenantId),
    fetchServedHistory(tenantId),
    fetchAnsweredQuestions(tenantId),
    fetchRecentPublishedPosts(tenantId),
  ]);
  const pillars = parsePillars(profile);
  const voice = parseVoiceContext(profile);

  // Fix #1: fetch the anchor insight BEFORE the vault fill so we can reserve it a
  // slot. When one exists, cap the pre-written vault cards at T3_DAILY_CAP-1 —
  // otherwise a deep vault_ideas backlog fills every slot and the insight (which
  // rides one LLM slot) never gets served. Guarantees one insight-grounded card/day.
  const anchorInsight = await fetchAnchorInsight(tenantId, history.usedInsightIds);
  const vaultCap = anchorInsight ? T3_DAILY_CAP - 1 : T3_DAILY_CAP;

  let cards = await pickVaultCards(tenantId, recommendedType, history.usedVaultIdeaIds, vaultCap);

  // Thin vault supply (fewer than 2 T3 cards) → reserve the last slot for the
  // daily question: answering it deposits a vault memory, which un-thins
  // tomorrow's supply. Self-balancing — question cards stop appearing once
  // the vault can fill the day on its own. (Spec R4.) The anchor insight counts
  // as supply — otherwise capping vault for it (Fix #1) would trip this and the
  // question would eat the slot we just reserved.
  const askQuestion = (cards.length + (anchorInsight ? 1 : 0)) < 2;
  const fillTarget = askQuestion ? CARDS_PER_DAY - 1 : CARDS_PER_DAY;

  // T3 vault cards are already written — the LLM call only writes their two
  // questions, keyed by ref. (Fallback: static questions if the call is skipped.)
  const presetCards = cards.map((c, idx) => ({ ref: `p${idx}`, hook: c.hook, post_type: c.post_type }));

  const remaining = fillTarget - cards.length;
  const sequelSeed = remaining > 0
    ? await pickSequelSeed(tenantId, history.usedPostRefs)
    : null;
  const hasProfileSubstance = !!(profile?.brand_industry || profile?.elevator_main_result || profile?.audience_description || pillars.length);
  let presetQuestions = {};
  // A vault insight alone is enough grounding to run the call, even with a thin profile.
  if ((remaining > 0 || presetCards.length) && (hasProfileSubstance || sequelSeed || anchorInsight)) {
    try {
      const result = await generateLlmCardsAndQuestions({
        profile, pillars, recommendedType, sequelSeed, anchorInsight,
        recentTitles: history.recentTitles,
        voice, answeredQuestions, recentPosts,
        savedHooks: history.savedHooks, dismissedHooks: history.dismissedHooks,
        presetCards, count: remaining,
      });
      if (remaining > 0) cards = cards.concat(result.cards);
      presetQuestions = result.presetQuestions || {};
    } catch (err) {
      console.error('[ideaEngine] LLM card generation failed (falling back to evergreen):', err.message);
    }
  }

  // Attach questions to the preset T3 cards (LLM-written where available, else static).
  cards.forEach((c, idx) => {
    if (c.tier === 3 && !c.questions) {
      const pq = presetQuestions[`p${idx}`];
      c.questions = pq ? llmQuestions(c.post_type, pq.qMoment, pq.qProof) : staticQuestions(c.post_type);
    }
  });

  if (cards.length < fillTarget) {
    cards = cards.concat(pickEvergreenCards({
      count: fillTarget - cards.length,
      recommendedType,
      usedEvergreenSlugs: history.usedEvergreenSlugs,
      profile, pillars,
    }));
  }
  cards = cards.slice(0, fillTarget);

  if (askQuestion) {
    const q = pickDailyQuestion({ postType: recommendedType, excludeSlugs: [...history.usedQuestionSlugs] });
    cards.push({
      tier: 0,
      title: 'Today\'s question',
      hook: fillTemplate(q.question, evergreenVals(profile, pillars)),
      textarea_input: '',
      post_type: q.post_type,
      provenance_ref: `question:${q.slug}`,
      provenance_label: 'Answer it — ScoutHook remembers and drafts',
      is_question: true,
      questions: null, // question cards use the answer flow, not the 2-question flow
    });
  }
  cards = cards.slice(0, CARDS_PER_DAY);

  const inserted = [];
  for (const c of cards) {
    const result = await db.prepare(`
      INSERT INTO idea_cards
        (user_id, tenant_id, hook, title, textarea_input, post_type, tier,
         provenance_ref, provenance_label, is_question, questions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).run(
      userId, tenantId, c.hook, c.title, c.textarea_input, c.post_type, c.tier,
      c.provenance_ref, c.provenance_label, c.is_question,
      c.questions ? JSON.stringify(c.questions) : null
    );
    inserted.push({ id: result.lastInsertRowid, status: 'served', served_on: null, ...c, questions: c.questions || null });
  }

  // Rotate the anchor insight only if it actually made it into a served card.
  if (anchorInsight && inserted.some(c => c.provenance_ref === `vault_insight:${anchorInsight.id}`)) {
    bumpInsightUsage(anchorInsight.id, tenantId);
  }

  logCardEvent('idea_cards_served', userId, tenantId, {
    tiers: inserted.map(c => c.tier),
    types: inserted.map(c => c.post_type),
  });

  return { cards: inserted, fresh: true };
}

// ---------------------------------------------------------------------------
// mintQuestionCard — on-demand question card ("New question" on the Ideas tab,
// Phase 2). Same dedup + interpolation as the daily-question slot, but not
// bound to the Today's 3 set — it's an extra row for today.
// ---------------------------------------------------------------------------
async function mintQuestionCard(userId, tenantId) {
  const [profile, recommendedType, history] = await Promise.all([
    fetchIdeaProfile(tenantId),
    getRecommendedType(tenantId),
    fetchServedHistory(tenantId),
  ]);
  const pillars = parsePillars(profile);
  const q = pickDailyQuestion({ postType: recommendedType, excludeSlugs: [...history.usedQuestionSlugs] });

  const result = await db.prepare(`
    INSERT INTO idea_cards
      (user_id, tenant_id, hook, title, textarea_input, post_type, tier,
       provenance_ref, provenance_label, is_question)
    VALUES (?, ?, ?, ?, '', ?, 0, ?, ?, true)
    RETURNING id, hook, title, post_type, tier, provenance_label, is_question, status
  `).get(
    userId, tenantId,
    fillTemplate(q.question, evergreenVals(profile, pillars)),
    'On-demand question',
    q.post_type,
    `question:${q.slug}`,
    'Answer it — ScoutHook remembers and drafts'
  );

  logCardEvent('idea_question_minted', userId, tenantId, { idea_card_id: Number(result.id) });
  return result;
}

// ---------------------------------------------------------------------------
// updateCardStatus — save / dismiss from the dashboard
// ---------------------------------------------------------------------------
async function updateCardStatus(cardId, tenantId, status) {
  const result = await db.prepare(`
    UPDATE idea_cards SET status = ?, updated_at = NOW()
    WHERE  id = ? AND tenant_id = ?
    RETURNING id
  `).run(status, cardId, tenantId);
  return !!result.lastInsertRowid;
}

// ---------------------------------------------------------------------------
// stampIdeaCard — called (fire-and-forget) when a generation that started from
// a card completes. Writes the origin onto the post row (north-star numerator)
// and closes the card's lifecycle.
// ---------------------------------------------------------------------------
function stampIdeaCard(ideaCardId, postId, userId, tenantId) {
  (async () => {
    await db.prepare(`
      UPDATE generated_posts SET idea_card_id = ?
      WHERE  id = ? AND tenant_id = ?
    `).run(ideaCardId, postId, tenantId);
    await db.prepare(`
      UPDATE idea_cards SET status = 'generated', updated_at = NOW()
      WHERE  id = ? AND tenant_id = ?
    `).run(ideaCardId, tenantId);
    logCardEvent('idea_card_generated', userId, tenantId, { idea_card_id: ideaCardId, post_id: postId });
  })().catch(err => console.error('[ideaEngine] stampIdeaCard failed (non-fatal):', err.message));
}

// ---------------------------------------------------------------------------
// logCardEvent — funnel instrumentation into platform_events (fire-and-forget)
// ---------------------------------------------------------------------------
function logCardEvent(eventType, userId, tenantId, metadata) {
  Promise.resolve(
    db.prepare(`
      INSERT INTO platform_events (event_type, user_id, workspace_id, metadata)
      VALUES (?, ?, ?, ?)
    `).run(eventType, userId || 'unknown', tenantId, JSON.stringify(metadata || {}))
  ).catch(err => console.error('[ideaEngine] logCardEvent failed (non-fatal):', err.message));
}

module.exports = { getDailyCards, updateCardStatus, stampIdeaCard, logCardEvent, mintQuestionCard, staticQuestions };

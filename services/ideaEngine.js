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

const SONNET_MODEL = 'claude-sonnet-4-6';
const T3_DAILY_CAP = 2;
const CARDS_PER_DAY = 3;

// ---------------------------------------------------------------------------
// Profile context (same shape the vault mining/suggest-topics paths use)
// ---------------------------------------------------------------------------
async function fetchIdeaProfile(tenantId) {
  return db.prepare(`
    SELECT p.content_pillars, p.input_examples,
           bvp.brand_industry, bvp.elevator_main_result, bvp.brand_core_beliefs,
           ap.audience_description, ap.audience_obstacles
    FROM profiles p
    LEFT JOIN brand_voice_profiles bvp ON bvp.profile_id = p.id
    LEFT JOIN audience_profiles ap ON ap.profile_id = p.id
    WHERE p.workspace_id = ? AND p.is_default = true
  `).get(tenantId);
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
    SELECT title, provenance_ref, served_on, status
    FROM   idea_cards
    WHERE  tenant_id = ?
      AND  served_on > CURRENT_DATE - INTERVAL '60 days'
  `).all(tenantId);

  const usedVaultIdeaIds = new Set();
  const usedEvergreenSlugs = new Set();
  const usedPostRefs = new Set();
  const usedQuestionSlugs = new Set();
  const recentTitles = [];
  for (const r of rows) {
    if (r.provenance_ref?.startsWith('vault_idea:')) usedVaultIdeaIds.add(Number(r.provenance_ref.slice(11)));
    if (r.provenance_ref?.startsWith('evergreen:'))  usedEvergreenSlugs.add(r.provenance_ref.slice(10));
    if (r.provenance_ref?.startsWith('post:'))       usedPostRefs.add(r.provenance_ref);
    if (r.provenance_ref?.startsWith('question:'))   usedQuestionSlugs.add(r.provenance_ref.slice(9));
    if (r.title) recentTitles.push(r.title);
  }
  return { usedVaultIdeaIds, usedEvergreenSlugs, usedPostRefs, usedQuestionSlugs, recentTitles };
}

// ---------------------------------------------------------------------------
// T3 — vault ideas (hook already written by the fire-and-forget Haiku pass)
// ---------------------------------------------------------------------------
async function pickVaultCards(tenantId, recommendedType, usedVaultIdeaIds) {
  const rows = await db.prepare(`
    SELECT vi.id, vi.seed_text, vi.funnel_type, vi.hook_preview, vd.filename
    FROM   vault_ideas vi
    LEFT   JOIN vault_documents vd ON vd.id = vi.document_id
    WHERE  vi.tenant_id = ?
      AND  vi.status = 'fresh'
      AND  vi.hook_preview IS NOT NULL AND vi.hook_preview <> ''
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
    .slice(0, T3_DAILY_CAP)
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
// T2+T1 — one Sonnet call writes all remaining cards
// ---------------------------------------------------------------------------
async function generateLlmCards({ profile, pillars, recommendedType, sequelSeed, recentTitles, count }) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) return [];

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

  const sequelBlock = sequelSeed
    ? `\nThe FIRST idea must be a follow-up ("sequel") to this post, which was one of their best performers recently — extend the topic with a new angle, deeper detail, or the next logical question. Do NOT rehash it:\n"""${String(sequelSeed.content || '').slice(0, 600)}"""\n`
    : '';

  const message = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `Generate ${count} LinkedIn post idea cards for this consultant.

${context}
${sequelBlock}
${recentTitles.length ? `Do NOT repeat any of these recently suggested angles:\n${recentTitles.slice(-30).map(t => `- ${t}`).join('\n')}\n` : ''}CRITICAL: Each card MUST reveal something about THEIR work or their audience's challenges — never generic "how to scale" advice. Use this template:

REACH cards: A specific moment from your consulting work that shows how your audience is different, a client situation that surprised you, or a pattern you've seen repeatedly.
TRUST cards: A non-obvious insight or contrarian belief from serving your audience, a mistake you see them make, or a misunderstanding about your field.
CONVERT cards: A specific result you or a client achieved, a before/after that illustrates the impact of your work, or an unexpected obstacle you help people overcome.

Rules for every card:
- "hook" is the actual FIRST LINE of the post (≤ 2 sentences) — specific, grounded, no generic advice
- "textarea_input" is 2–3 first-person sentences the author would type as raw material (e.g., "A client told me X" or "I realized Y when..."), with specific detail
- "title" is a 3–7 word topic label
- "post_type" is one of reach|trust|convert — at least one must be "${recommendedType}"
- Each hook must pass this test: "Could I only write this based on my specific consulting experience?" If not, it's too generic.

Return ONLY a JSON array of ${count} objects: [{"title": "...", "hook": "...", "textarea_input": "...", "post_type": "..."}]`,
    }],
  });

  const raw = message.content[0]?.text || '[]';
  let ideas = [];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    ideas = JSON.parse(match ? match[0] : raw);
    if (!Array.isArray(ideas)) ideas = [];
  } catch { ideas = []; }

  return ideas
    .filter(i => i && typeof i.hook === 'string' && i.hook.trim())
    .slice(0, count)
    .map((i, idx) => {
      const isSequel = !!sequelSeed && idx === 0;
      return {
        tier: isSequel ? 2 : 1,
        title: typeof i.title === 'string' ? i.title.slice(0, 120) : null,
        hook: i.hook.trim(),
        textarea_input: typeof i.textarea_input === 'string' ? i.textarea_input : '',
        post_type: ['reach', 'trust', 'convert', 'lead_magnet'].includes(i.post_type) ? i.post_type : recommendedType,
        provenance_ref: isSequel ? `post:${sequelSeed.id}` : 'profile',
        provenance_label: isSequel ? 'Sequel to your top post this month' : 'From your positioning',
        is_question: false,
      };
    });
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
      };
    });
}

// ---------------------------------------------------------------------------
// getDailyCards(userId, tenantId) → { cards, fresh }
// ---------------------------------------------------------------------------
async function getDailyCards(userId, tenantId) {
  const existing = await db.prepare(`
    SELECT id, hook, title, textarea_input, post_type, tier,
           provenance_ref, provenance_label, is_question, status, served_on
    FROM   idea_cards
    WHERE  tenant_id = ? AND served_on = CURRENT_DATE
    ORDER  BY id
  `).all(tenantId);
  if (existing.length) return { cards: existing, fresh: false };

  const [profile, recommendedType, history] = await Promise.all([
    fetchIdeaProfile(tenantId),
    getRecommendedType(tenantId),
    fetchServedHistory(tenantId),
  ]);
  const pillars = parsePillars(profile);

  let cards = await pickVaultCards(tenantId, recommendedType, history.usedVaultIdeaIds);

  // Thin vault supply (fewer than 2 T3 cards) → reserve the last slot for the
  // daily question: answering it deposits a vault memory, which un-thins
  // tomorrow's supply. Self-balancing — question cards stop appearing once
  // the vault can fill the day on its own. (Spec R4.)
  const askQuestion = cards.length < 2;
  const fillTarget = askQuestion ? CARDS_PER_DAY - 1 : CARDS_PER_DAY;

  const remaining = fillTarget - cards.length;
  if (remaining > 0) {
    const sequelSeed = await pickSequelSeed(tenantId, history.usedPostRefs);
    const hasProfileSubstance = !!(profile?.brand_industry || profile?.elevator_main_result || profile?.audience_description || pillars.length);
    if (hasProfileSubstance || sequelSeed) {
      try {
        const llmCards = await generateLlmCards({
          profile, pillars, recommendedType, sequelSeed,
          recentTitles: history.recentTitles,
          count: remaining,
        });
        cards = cards.concat(llmCards);
      } catch (err) {
        console.error('[ideaEngine] LLM card generation failed (falling back to evergreen):', err.message);
      }
    }
  }

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
    });
  }
  cards = cards.slice(0, CARDS_PER_DAY);

  const inserted = [];
  for (const c of cards) {
    const result = await db.prepare(`
      INSERT INTO idea_cards
        (user_id, tenant_id, hook, title, textarea_input, post_type, tier,
         provenance_ref, provenance_label, is_question)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).run(
      userId, tenantId, c.hook, c.title, c.textarea_input, c.post_type, c.tier,
      c.provenance_ref, c.provenance_label, c.is_question
    );
    inserted.push({ id: result.lastInsertRowid, status: 'served', served_on: null, ...c });
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

module.exports = { getDailyCards, updateCardStatus, stampIdeaCard, logCardEvent, mintQuestionCard };

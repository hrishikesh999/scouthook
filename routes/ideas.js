'use strict';

/**
 * routes/ideas.js — "Today's 3" idea cards API (Idea Engine Phase 1 + 2)
 *
 * GET  /api/ideas/today        Serve (or generate + cache) today's 3 cards
 * POST /api/ideas/:id/clicked  Funnel event — user tapped "Write this →"
 * POST /api/ideas/:id/save     Save card to the queue
 * POST /api/ideas/:id/dismiss  Dismiss card ("Not for me") — never re-served
 * POST /api/ideas/:id/answer   Answer a daily question card
 *
 * Phase 2 (retention layer — sprint-idea-engine-phase2.md):
 * GET  /api/ideas/queue        Saved cards (oldest first) + answered questions
 * GET  /api/ideas/queue-count  Badge count for the sidebar Ideas entry
 * POST /api/ideas/:id/archive  Remove a saved card from the queue (soft-delete)
 * POST /api/ideas/question     Mint a fresh question card on demand
 * GET  /api/ideas/streak       Consistency counter for the dashboard
 */

const express = require('express');
const router = express.Router();
const { db, getSetting } = require('../db');
const { getDailyCards, updateCardStatus, logCardEvent, mintQuestionCard, staticQuestions } = require('../services/ideaEngine');

// Every card that drives the "Write this" 2-question flow must carry two
// questions. Regular cards: pre-minted, or the static per-type pair as a
// fallback for pre-migration rows. Question cards: null until answered, then
// the deepening follow-ups minted at answer time (POST /:id/answer) — so an
// answered question card flows through the same targeted flow, grounded in the
// user's own answer, instead of the generic interview.
function withQuestions(c) {
  if (c.is_question) return c.questions || null;
  return c.questions || staticQuestions(c.post_type);
}
const { recordStreakAction, getStreak } = require('../services/streak');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

function requireUser(req, res) {
  if (!req.userId) {
    res.status(400).json({ ok: false, error: 'missing_user_id' });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// GET /api/ideas/today
// ---------------------------------------------------------------------------
router.get('/today', async (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const { cards, fresh } = await getDailyCards(req.userId, req.tenantId);
    return res.json({
      ok: true,
      fresh,
      cards: cards
        // Saved cards move to the Ideas queue; dismissed cards are gone — either
        // way they must not linger on today's dashboard list.
        .filter(c => c.status !== 'dismissed' && c.status !== 'saved')
        .map(c => ({
          id: c.id,
          hook: c.hook,
          title: c.title,
          post_type: c.post_type,
          tier: c.tier,
          provenance_label: c.provenance_label,
          textarea_input: c.textarea_input,
          is_question: !!c.is_question,
          questions: withQuestions(c),
          status: c.status,
        })),
    });
  } catch (err) {
    console.error('[ideas] GET /today error:', err.message);
    return res.status(500).json({ ok: false, error: 'ideas_unavailable' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ideas/queue — the Ideas tab (Phase 2, spec R9)
// Saved cards oldest-first (the queue is FIFO: act on what you saved first)
// plus recently answered questions (each one is a vault memory the user can
// still turn into a post).
// ---------------------------------------------------------------------------
router.get('/queue', async (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const [saved, answered] = await Promise.all([
      db.prepare(`
        SELECT id, hook, title, textarea_input, post_type, tier,
               provenance_label, is_question, questions, served_on, updated_at
        FROM   idea_cards
        WHERE  tenant_id = ? AND status = 'saved'
        ORDER  BY updated_at ASC
        LIMIT  100
      `).all(req.tenantId),
      db.prepare(`
        SELECT vi.id, vi.seed_text, vi.source_ref, vi.hook_preview,
               vi.funnel_type, vi.created_at, vi.status
        FROM   vault_ideas vi
        WHERE  vi.tenant_id = ? AND vi.source = 'daily_question'
        ORDER  BY vi.created_at DESC
        LIMIT  15
      `).all(req.tenantId),
    ]);

    return res.json({
      ok: true,
      saved: saved.map(c => ({
        id: c.id,
        hook: c.hook,
        title: c.title,
        post_type: c.post_type,
        tier: c.tier,
        provenance_label: c.provenance_label,
        textarea_input: c.textarea_input,
        is_question: !!c.is_question,
        questions: withQuestions(c),
        saved_on: c.updated_at,
        served_on: c.served_on,
      })),
      answered: answered.map(a => ({
        vault_idea_id: a.id,
        question: (a.source_ref || '').replace(/^You answered: "|"$/g, ''),
        answer: a.seed_text,
        hook: a.hook_preview,
        post_type: a.funnel_type,
        answered_at: a.created_at,
        used: a.status !== 'fresh',
      })),
    });
  } catch (err) {
    console.error('[ideas] GET /queue error:', err.message);
    return res.status(500).json({ ok: false, error: 'queue_unavailable' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ideas/queue-count — sidebar badge (cheap; called on every page load)
// ---------------------------------------------------------------------------
router.get('/queue-count', async (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const row = await db.prepare(
      "SELECT COUNT(*) AS n FROM idea_cards WHERE tenant_id = ? AND status = 'saved'"
    ).get(req.tenantId);
    return res.json({ ok: true, count: Number(row?.n || 0) });
  } catch {
    return res.json({ ok: true, count: 0 });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ideas/streak — Consistency counter (Phase 2, spec R7)
// ---------------------------------------------------------------------------
router.get('/streak', async (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    return res.json({ ok: true, ...(await getStreak(req.userId)) });
  } catch (err) {
    console.error('[ideas] GET /streak error:', err.message);
    return res.status(500).json({ ok: false, error: 'streak_unavailable' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/ideas/question — mint a fresh question card on demand
// ("New question" button on the Ideas tab)
// ---------------------------------------------------------------------------
router.post('/question', async (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const card = await mintQuestionCard(req.userId, req.tenantId);
    return res.json({
      ok: true,
      card: {
        id: card.id,
        hook: card.hook,
        title: card.title,
        post_type: card.post_type,
        tier: card.tier,
        provenance_label: card.provenance_label,
        is_question: true,
        status: card.status,
      },
    });
  } catch (err) {
    console.error('[ideas] POST /question error:', err.message);
    return res.status(500).json({ ok: false, error: 'question_unavailable' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ideas/:id — a single card incl. its pre-minted extraction questions.
// generate.html fetches this on "Write this →" to drive the 2-question flow
// (works identically for dashboard, pill drawer, Ideas tab, and email links).
// Declared AFTER the static GETs above so it can't shadow /today, /queue, etc.
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  if (!requireUser(req, res)) return;
  const cardId = Number(req.params.id);
  if (!cardId) return res.status(400).json({ ok: false, error: 'invalid_card_id' });
  try {
    const c = await db.prepare(`
      SELECT id, hook, title, textarea_input, post_type, tier,
             provenance_label, is_question, questions, status
      FROM   idea_cards
      WHERE  id = ? AND tenant_id = ?
    `).get(cardId, req.tenantId);
    if (!c) return res.status(404).json({ ok: false, error: 'card_not_found' });
    return res.json({
      ok: true,
      card: {
        id: c.id,
        hook: c.hook,
        title: c.title,
        post_type: c.post_type,
        tier: c.tier,
        provenance_label: c.provenance_label,
        textarea_input: c.textarea_input,
        is_question: !!c.is_question,
        questions: withQuestions(c),
        status: c.status,
      },
    });
  } catch (err) {
    console.error('[ideas] GET /:id error:', err.message);
    return res.status(500).json({ ok: false, error: 'card_unavailable' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/ideas/:id/clicked — fire-and-forget funnel marker
// ---------------------------------------------------------------------------
router.post('/:id/clicked', (req, res) => {
  if (!requireUser(req, res)) return;
  logCardEvent('idea_card_clicked', req.userId, req.tenantId, { idea_card_id: Number(req.params.id) || null });
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/ideas/:id/save · /:id/dismiss
// ---------------------------------------------------------------------------
async function setStatus(req, res, status, eventType) {
  if (!requireUser(req, res)) return false;
  const cardId = Number(req.params.id);
  if (!cardId) { res.status(400).json({ ok: false, error: 'invalid_card_id' }); return false; }
  try {
    const updated = await updateCardStatus(cardId, req.tenantId, status);
    if (!updated) { res.status(404).json({ ok: false, error: 'card_not_found' }); return false; }
    logCardEvent(eventType, req.userId, req.tenantId, { idea_card_id: cardId });
    res.json({ ok: true });
    return true;
  } catch (err) {
    console.error(`[ideas] POST /:id/${status} error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
    return false;
  }
}

router.post('/:id/save', async (req, res) => {
  const ok = await setStatus(req, res, 'saved', 'idea_card_saved');
  if (ok) recordStreakAction(req.userId, req.tenantId, 'save');
});
router.post('/:id/dismiss', (req, res) => setStatus(req, res, 'dismissed', 'idea_card_dismissed'));
// Archive: soft-delete out of the Ideas-tab queue. Distinct from dismiss —
// the user acted on it (or moved past it), we just stop showing it. Never
// re-served either way (fetchServedHistory dedups on provenance, not status).
router.post('/:id/archive', (req, res) => setStatus(req, res, 'archived', 'idea_card_archived'));

// ---------------------------------------------------------------------------
// POST /api/ideas/:id/answer — daily question card (spec R4)
// The answer becomes a permanent vault memory (source='daily_question', feeds
// tomorrow's T3 supply once its hook_preview lands). It ALSO turns the question
// card into a seed for today's post: we mint two deepening follow-up questions
// grounded in the answer and store them (+ the answer) on the card, so the
// client can hand off into the SAME targeted 2-question flow the idea cards use
// — post type locked, no picker, two specific questions — rather than the
// generic multi-question interview.
// ---------------------------------------------------------------------------
router.post('/:id/answer', async (req, res) => {
  if (!requireUser(req, res)) return;
  const cardId = Number(req.params.id);
  const answer = (req.body?.answer || '').trim();
  if (!cardId) return res.status(400).json({ ok: false, error: 'invalid_card_id' });
  if (answer.length < 20) return res.status(422).json({ ok: false, error: 'answer_too_short' });

  try {
    const card = await db.prepare(`
      SELECT id, hook, post_type, is_question FROM idea_cards
      WHERE  id = ? AND tenant_id = ?
    `).get(cardId, req.tenantId);
    if (!card) return res.status(404).json({ ok: false, error: 'card_not_found' });
    if (!card.is_question) return res.status(400).json({ ok: false, error: 'not_a_question_card' });

    const seedText = answer.slice(0, 2000);
    const insert = await db.prepare(`
      INSERT INTO vault_ideas
        (user_id, tenant_id, seed_text, source_ref, funnel_type, source, status)
      VALUES (?, ?, ?, ?, ?, 'daily_question', 'fresh')
      RETURNING id
    `).run(
      req.userId, req.tenantId, seedText,
      `You answered: "${String(card.hook).slice(0, 90)}"`,
      ['reach', 'trust', 'convert'].includes(card.post_type) ? card.post_type : null
    );
    const vaultIdeaId = insert.lastInsertRowid;

    // Awaited: the card must carry two questions BEFORE the client navigates
    // into the 2-question flow, or generate.html falls back to the generic path.
    // One Haiku call yields both the follow-ups and the T3 hook preview.
    const minted = await mintAnswerFollowups(card.hook, seedText, card.post_type);

    await db.prepare(`
      UPDATE idea_cards
      SET    status = 'answered', textarea_input = ?, questions = ?, updated_at = NOW()
      WHERE  id = ? AND tenant_id = ?
    `).run(seedText, JSON.stringify(minted.questions), cardId, req.tenantId);

    // hook preview → tomorrow's T3 supply (non-fatal if the model gave us none)
    if (minted.hook) {
      Promise.resolve(
        db.prepare('UPDATE vault_ideas SET hook_preview = ? WHERE id = ? AND tenant_id = ?')
          .run(minted.hook, vaultIdeaId, req.tenantId)
      ).catch(() => {});
    }

    logCardEvent('idea_question_answered', req.userId, req.tenantId, { idea_card_id: cardId, vault_idea_id: vaultIdeaId });
    recordStreakAction(req.userId, req.tenantId, 'answer');

    return res.json({ ok: true, vault_idea_id: vaultIdeaId, questions: minted.questions });
  } catch (err) {
    console.error('[ideas] POST /:id/answer error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Mint two DEEPENING follow-up questions (+ a T3 hook preview) grounded in a
// question card's answer, in one Haiku call. Returns { hook, questions } in the
// same shape as ideaEngine's llmQuestions; on any failure falls back to the
// static per-type pair so the card always drives the 2-question flow.
async function mintAnswerFollowups(question, answer, postType) {
  const fallback = { hook: null, questions: staticQuestions(postType) };
  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) return fallback;
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `A consultant answered a reflection prompt about their work. Deepen their answer into two follow-up questions that pull out the specifics a strong LinkedIn post needs.

Prompt: ${String(question).slice(0, 200)}
Their answer: ${String(answer).slice(0, 800)}

Return ONLY a JSON object with three fields:
- "hook": one arresting LinkedIn opening line (8-12 words) built on their answer — specific, opinionated, no filler, no hashtags.
- "q_moment": a question that pulls out the SPECIFIC moment behind their answer — the client, conversation, decision, or day it happened. Reference their answer concretely. Second person ("you"), <=140 chars, never yes/no.
- "q_proof": a question that pulls out concrete proof — a number, timeframe, before/after, or the exact words someone used. Second person, <=140 chars, never yes/no.

JSON only, no other text.`,
      }],
    });
    const text = message.content?.[0]?.text || '{}';
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    const m = typeof parsed.q_moment === 'string' ? parsed.q_moment.trim().slice(0, 200) : '';
    const p = typeof parsed.q_proof === 'string' ? parsed.q_proof.trim().slice(0, 200) : '';
    const hook = typeof parsed.hook === 'string'
      ? parsed.hook.trim().replace(/^["']|["']$/g, '').slice(0, 200) : null;
    if (!m || !p) return { hook, questions: staticQuestions(postType) };
    return {
      hook,
      questions: {
        v: 1,
        source: 'llm',
        items: [
          { key: 'moment', q: m, help: 'One specific moment, in plain words.' },
          { key: 'proof',  q: p, help: 'A concrete number or outcome makes it credible.' },
        ],
      },
    };
  } catch (err) {
    console.error('[ideas] mintAnswerFollowups failed (non-fatal):', err.message);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// POST /api/ideas/answered/:vaultIdeaId/write — prepare an already-answered
// question (a daily_question vault_idea, shown on the Ideas tab) for the
// 2-question flow. The answer lives on the vault_idea, so we mint two deepening
// follow-ups from the stored Q+answer and return a dedicated idea_card the
// client hands off via idea_card=. served_on is a sentinel past date so this
// write-session card never enters the dashboard's Today's-3 set or the 60-day
// dedup history. Re-uses an existing prepared card to avoid duplicates.
// ---------------------------------------------------------------------------
router.post('/answered/:vaultIdeaId/write', async (req, res) => {
  if (!requireUser(req, res)) return;
  const viId = Number(req.params.vaultIdeaId);
  if (!viId) return res.status(400).json({ ok: false, error: 'invalid_id' });
  try {
    const vi = await db.prepare(`
      SELECT id, seed_text, source_ref, funnel_type FROM vault_ideas
      WHERE  id = ? AND tenant_id = ? AND source = 'daily_question'
    `).get(viId, req.tenantId);
    if (!vi) return res.status(404).json({ ok: false, error: 'answer_not_found' });

    const question = (vi.source_ref || '').replace(/^You answered: "|"$/g, '').trim() || 'Your answer';
    const answer   = (vi.seed_text || '').trim();
    const postType = ['reach', 'trust', 'convert'].includes(vi.funnel_type) ? vi.funnel_type : 'reach';

    // Reuse a prior prepared card for this answer (idempotent re-clicks).
    const existing = await db.prepare(`
      SELECT id, post_type FROM idea_cards
      WHERE  tenant_id = ? AND provenance_ref = ? AND questions IS NOT NULL
      LIMIT  1
    `).get(req.tenantId, `answered:${viId}`);
    if (existing) return res.json({ ok: true, card_id: existing.id, post_type: existing.post_type });

    const minted = await mintAnswerFollowups(question, answer, postType);
    const inserted = await db.prepare(`
      INSERT INTO idea_cards
        (user_id, tenant_id, hook, title, textarea_input, post_type, tier,
         provenance_ref, provenance_label, is_question, questions, status, served_on)
      VALUES (?, ?, ?, 'Your answer', ?, ?, 0, ?, 'From your answered question', true, ?, 'answered', DATE '2000-01-01')
      RETURNING id
    `).run(
      req.userId, req.tenantId, question, answer, postType,
      `answered:${viId}`, JSON.stringify(minted.questions)
    );
    return res.json({ ok: true, card_id: inserted.lastInsertRowid, post_type: postType });
  } catch (err) {
    console.error('[ideas] POST /answered/:id/write error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

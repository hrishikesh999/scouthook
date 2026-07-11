'use strict';

/**
 * routes/ideas.js — "Today's 3" idea cards API (Idea Engine Phase 1)
 *
 * GET  /api/ideas/today        Serve (or generate + cache) today's 3 cards
 * POST /api/ideas/:id/clicked  Funnel event — user tapped "Write this →"
 * POST /api/ideas/:id/save     Save card to the queue
 * POST /api/ideas/:id/dismiss  Dismiss card ("Not for me") — never re-served
 */

const express = require('express');
const router = express.Router();
const { db, getSetting } = require('../db');
const { getDailyCards, updateCardStatus, logCardEvent } = require('../services/ideaEngine');

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
        .filter(c => c.status !== 'dismissed')
        .map(c => ({
          id: c.id,
          hook: c.hook,
          title: c.title,
          post_type: c.post_type,
          tier: c.tier,
          provenance_label: c.provenance_label,
          textarea_input: c.textarea_input,
          is_question: !!c.is_question,
          status: c.status,
        })),
    });
  } catch (err) {
    console.error('[ideas] GET /today error:', err.message);
    return res.status(500).json({ ok: false, error: 'ideas_unavailable' });
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
  if (!requireUser(req, res)) return;
  const cardId = Number(req.params.id);
  if (!cardId) return res.status(400).json({ ok: false, error: 'invalid_card_id' });
  try {
    const updated = await updateCardStatus(cardId, req.tenantId, status);
    if (!updated) return res.status(404).json({ ok: false, error: 'card_not_found' });
    logCardEvent(eventType, req.userId, req.tenantId, { idea_card_id: cardId });
    return res.json({ ok: true });
  } catch (err) {
    console.error(`[ideas] POST /:id/${status} error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

router.post('/:id/save',    (req, res) => setStatus(req, res, 'saved',     'idea_card_saved'));
router.post('/:id/dismiss', (req, res) => setStatus(req, res, 'dismissed', 'idea_card_dismissed'));

// ---------------------------------------------------------------------------
// POST /api/ideas/:id/answer — daily question card (spec R4)
// The answer becomes a permanent vault memory (source='daily_question', feeds
// tomorrow's T3 supply once its hook_preview lands) AND today's post seed —
// the client redirects into the generator with the Q+A prefilled.
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

    await updateCardStatus(cardId, req.tenantId, 'answered');
    logCardEvent('idea_question_answered', req.userId, req.tenantId, { idea_card_id: cardId, vault_idea_id: vaultIdeaId });
    generateHookPreview(vaultIdeaId, req.tenantId, card.hook, seedText); // fire-and-forget

    return res.json({ ok: true, vault_idea_id: vaultIdeaId });
  } catch (err) {
    console.error('[ideas] POST /:id/answer error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Fire-and-forget: write a ≤12-word hook onto the new memory so it qualifies
// for the T3 tier of Today's 3 (pickVaultCards requires a hook_preview).
function generateHookPreview(vaultIdeaId, tenantId, question, answer) {
  (async () => {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) return;
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 60,
      messages: [{
        role: 'user',
        content: `A consultant answered a prompt about their work.

Prompt: ${String(question).slice(0, 200)}
Their answer: ${String(answer).slice(0, 800)}

Write ONE arresting LinkedIn post opening line (8-12 words) built on their answer — specific, opinionated, no filler, no hashtags. Return only the line.`,
      }],
    });
    const hook = (message.content?.[0]?.text || '').trim().replace(/^["']|["']$/g, '').slice(0, 200);
    if (!hook) return;
    await db.prepare(
      'UPDATE vault_ideas SET hook_preview = ? WHERE id = ? AND tenant_id = ?'
    ).run(hook, vaultIdeaId, tenantId);
  })().catch(err => console.error('[ideas] hook preview failed (non-fatal):', err.message));
}

module.exports = router;

'use strict';

/**
 * services/factExtraction.js — auto-memories (Idea Engine Phase 1, spec R3).
 *
 * Mines the user's raw generation input for concrete, reusable facts about
 * their work (client outcomes, numbers, named situations, hard-won opinions)
 * and stores each as a vault_ideas row with source='auto_extracted' — so it
 * shows up in the existing vault UI (visible, deletable) and feeds the T3
 * tier of the Today's 3 supply ladder via its hook_preview.
 *
 * Called fire-and-forget from POST /api/generate BEFORE RAG enrichment, so it
 * only ever sees text the user actually typed/spoke. Never blocks generation.
 * Conservative by design: max 3 facts per session, concrete facts only,
 * returns nothing rather than guessing.
 */

const { db, getSetting } = require('../db');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const MIN_INPUT_CHARS = 200;
const MAX_FACTS_PER_SESSION = 1;

async function getClient() {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
}

// Fire-and-forget entry point — callers do not await this.
function extractFactsFromInput(userId, tenantId, rawInput) {
  const input = (rawInput || '').trim();
  if (input.length < MIN_INPUT_CHARS) return;
  runExtraction(userId, tenantId, input)
    .catch(err => console.error('[factExtraction] failed (non-fatal):', err.message));
}

async function runExtraction(userId, tenantId, input) {
  const client = await getClient();
  if (!client) return;

  // Recent memories — passed as exclusions so regenerating a similar idea
  // doesn't re-save the same fact. Includes daily-question answers: those are
  // stored verbatim as memories, and their text flows back through generation.
  const recent = await db.prepare(`
    SELECT seed_text FROM vault_ideas
    WHERE  tenant_id = ? AND source IN ('auto_extracted', 'daily_question')
    ORDER  BY created_at DESC
    LIMIT  20
  `).all(tenantId);
  const recentSeeds = recent.map(r => r.seed_text);

  const message = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `A consultant typed this raw input while drafting a LinkedIn post:

"""${input.slice(0, 2000)}"""

Extract UP TO 1 CONCRETE, reusable fact about THEIR work worth remembering for future posts — and ONLY if it's genuinely specific and novel. A fact qualifies only if: (1) it contains a specific number, result, or timescale tied to a real client/project, (2) it reveals a non-obvious insight from their consulting practice, (3) it could become a standalone LinkedIn hook that would stop someone scrolling. Generic advice, process-description, and restatements of the draft idea itself do NOT qualify. When in doubt, return an empty array.
${recentSeeds.length ? `\nAlready remembered (do NOT re-extract anything covering the same ground):\n${recentSeeds.map(s => `- ${String(s).slice(0, 120)}`).join('\n')}\n` : ''}
For each fact also write:
- "hook": a possible LinkedIn post first line built on the fact (≤ 12 words)
- "post_type": one of reach|trust|convert

Return ONLY a JSON array (empty array if nothing qualifies — that is a good answer):
[{"fact": "1-2 sentence statement of the fact", "hook": "...", "post_type": "..."}]`,
    }],
  });

  const raw = message.content?.[0]?.text || '[]';
  let facts = [];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    facts = JSON.parse(match ? match[0] : raw);
    if (!Array.isArray(facts)) facts = [];
  } catch { facts = []; }

  facts = facts
    .filter(f => f && typeof f.fact === 'string' && f.fact.trim().length > 30)
    .slice(0, MAX_FACTS_PER_SESSION);
  if (!facts.length) return;

  for (const f of facts) {
    await db.prepare(`
      INSERT INTO vault_ideas
        (user_id, tenant_id, seed_text, source_ref, funnel_type, hook_preview, source, status)
      VALUES (?, ?, ?, ?, ?, ?, 'auto_extracted', 'fresh')
    `).run(
      userId, tenantId,
      f.fact.trim(),
      'Remembered from your post input',
      ['reach', 'trust', 'convert'].includes(f.post_type) ? f.post_type : null,
      typeof f.hook === 'string' ? f.hook.trim().slice(0, 200) : null
    );
  }

  // Funnel visibility — how often the flywheel actually deposits something
  Promise.resolve(db.prepare(`
    INSERT INTO platform_events (event_type, user_id, workspace_id, metadata)
    VALUES ('auto_memory_saved', ?, ?, ?)
  `).run(userId, tenantId, JSON.stringify({ count: facts.length })))
    .catch(err => console.error('[factExtraction] event log failed (non-fatal):', err.message));
}

module.exports = { extractFactsFromInput };

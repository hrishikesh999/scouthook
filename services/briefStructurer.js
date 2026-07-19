'use strict';

/**
 * services/briefStructurer.js — "Talk it out" capture (Authentic Client Engine, Phase 1.3).
 *
 * A founder speaks for 60–90 seconds; Web Speech gives us a transcript (no audio
 * is uploaded or stored). This turns that raw transcript into the fields the
 * interview flow expects — moment / proof / tension / audience_hook — plus a
 * suggested post type and any leftover story fragments worth banking for future
 * posts.
 *
 * Hard rule (mirrors services/factExtraction.js): extract ONLY what the speaker
 * actually said. Never invent a number, outcome, or detail. Empty fields are a
 * correct answer — the interview coach then asks about the gaps. This keeps the
 * whole capture path provenance-clean: everything it emits is the author's words.
 *
 * Fast + cheap (Haiku): this is extraction, not writing.
 */

const { getSetting } = require('../db');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const MIN_TRANSCRIPT_CHARS = 40;

const VALID_POST_TYPES = new Set([
  'trust', 'story', 'lessons_learned', 'bts', 'contrarian',
  'framework', 'announcement', 'lead_gen', 'pis', 'results',
]);

async function getClient() {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
}

/**
 * @param {string} transcript
 * @returns {Promise<{ moment, proof, tension, audience_hook, suggested_post_type, leftover_facts }>}
 *   All string fields default to '' and leftover_facts to [] when nothing qualifies.
 */
async function structureBrief(transcript) {
  const text = (transcript || '').trim();
  const empty = { moment: '', proof: '', tension: '', audience_hook: '', suggested_post_type: null, leftover_facts: [] };
  if (text.length < MIN_TRANSCRIPT_CHARS) return empty;

  const client = await getClient();
  if (!client) return empty;

  let message;
  try {
    message = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: `A B2B founder spoke this out loud while thinking about a LinkedIn post (raw speech-to-text):

"""
${text.slice(0, 4000)}
"""

Pull out ONLY what they actually said. Never invent a number, result, client, or detail. If something isn't in the transcript, leave that field an empty string — that is the correct answer, not a guess.

Fields:
- "moment": the specific scene/situation/time they described (empty if none)
- "proof": any concrete number, timeframe, or named result they stated verbatim (empty if none — do NOT infer or round)
- "tension": the contradiction, surprise, or before/after they voiced (empty if none)
- "audience_hook": who this helps and why, in their framing (empty if none)
- "suggested_post_type": the best fit from exactly this list, or null:
    story, lessons_learned, bts, contrarian, framework, results, trust, pis, lead_gen, announcement
- "leftover_facts": an array (0–2) of OTHER concrete, reusable stories/insights they mentioned but that don't belong in this post — each { "fact": "...", "hook": "≤12-word possible first line" }. Empty array if none.

Return ONLY a JSON object, no markdown, no prose:
{"moment":"","proof":"","tension":"","audience_hook":"","suggested_post_type":null,"leftover_facts":[]}`,
      }],
    });
  } catch (err) {
    console.error('[briefStructurer] failed (non-fatal):', err.message);
    return empty;
  }

  const raw = message.content?.[0]?.text || '{}';
  return normaliseStructured(raw);
}

/**
 * Parse + sanitise the model output into the strict field shape. Pure — exported
 * for testing (asserts empty proof when the transcript had no numbers).
 * @param {string} raw
 */
function normaliseStructured(raw) {
  const empty = { moment: '', proof: '', tension: '', audience_hook: '', suggested_post_type: null, leftover_facts: [] };
  let obj;
  try {
    const match = String(raw).match(/\{[\s\S]*\}/);
    obj = JSON.parse(match ? match[0] : raw);
  } catch { return empty; }
  if (!obj || typeof obj !== 'object') return empty;

  const str = v => (typeof v === 'string' ? v.trim() : '');
  const postType = str(obj.suggested_post_type).toLowerCase();

  const leftovers = Array.isArray(obj.leftover_facts) ? obj.leftover_facts : [];
  const leftover_facts = leftovers
    .filter(f => f && typeof f.fact === 'string' && f.fact.trim().length > 20)
    .slice(0, 2)
    .map(f => ({
      fact: f.fact.trim(),
      hook: typeof f.hook === 'string' ? f.hook.trim().slice(0, 120) : '',
    }));

  return {
    moment:              str(obj.moment),
    proof:               str(obj.proof),
    tension:             str(obj.tension),
    audience_hook:       str(obj.audience_hook),
    suggested_post_type: VALID_POST_TYPES.has(postType) ? postType : null,
    leftover_facts,
  };
}

module.exports = { structureBrief, normaliseStructured };

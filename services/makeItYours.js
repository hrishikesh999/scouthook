'use strict';

/**
 * services/makeItYours.js — the "Make It Yours" pass (Authentic Client Engine, Phase 2).
 *
 * After a post is generated, this suggests 2–3 short spans the author should
 * rewrite in their own words — the hook and the final-third punchline above all,
 * because those positions decide dwell time and are where a machine cadence is
 * most detectable. A human sentence dropped into those exact slots breaks the
 * template rhythm and gives the author ownership (which changes how they show up
 * in the comments).
 *
 * Design constraints:
 *  - Never blocks. On any error/parse failure returns { spans: [] } and the UI
 *    silently skips the step.
 *  - Every returned `excerpt` MUST appear verbatim in the post — validated with
 *    indexOf here so the frontend can highlight it reliably. Non-matching spans
 *    are dropped, not repaired.
 *  - Haiku (fast, cheap): this is a locate-and-explain task, not writing.
 */

const { db, getSetting } = require('../db');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const MAX_SPANS = 3;

async function getClient() {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
}

const VALID_SLOTS = new Set(['hook', 'punchline', 'bridge']);

/**
 * Suggest personal-rewrite spans for a generated post.
 * @param {string} postText
 * @param {object} [profile]  optional — used only to tailor the coaching prompt tone
 * @returns {Promise<{ spans: Array<{excerpt,slot,why,prompt}> }>}
 */
async function suggestPersonalSpans(postText, profile = {}) {
  const text = (postText || '').trim();
  if (text.length < 40) return { spans: [] };

  const client = await getClient();
  if (!client) return { spans: [] };

  const niche = profile.brand_description ? ` The author is: ${profile.brand_description}.` : '';

  let message;
  try {
    message = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Here is a LinkedIn post drafted for a real person.${niche}

"""
${text.slice(0, 3000)}
"""

Pick the 2–3 sentences that would benefit MOST from being rewritten in the author's own voice — the places where a human sentence changes how the post lands. Prioritise:
1. The HOOK (first line) — always include it.
2. The PUNCHLINE — the sharpest line, usually in the final third.
3. Optionally ONE bridge/transition sentence if it reads generic.

For each, return the EXACT sentence copied verbatim from the post (so it can be highlighted), a slot label, a one-line reason, and a short question that prompts the author to say it their way.

Return ONLY a JSON array (no prose, no markdown fences):
[{"excerpt":"exact sentence from the post, copied verbatim","slot":"hook|punchline|bridge","why":"one line: why this needs the author's own words","prompt":"a short question, e.g. 'How would you actually say this to a client?'"}]`,
      }],
    });
  } catch (err) {
    console.error('[makeItYours] generation failed (non-fatal):', err.message);
    return { spans: [] };
  }

  const raw = message.content?.[0]?.text || '[]';
  let parsed = [];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    parsed = JSON.parse(match ? match[0] : raw);
    if (!Array.isArray(parsed)) parsed = [];
  } catch { parsed = []; }

  return { spans: filterValidSpans(parsed, text) };
}

/**
 * Keep only spans whose excerpt appears verbatim in `text`, dedupe, normalise
 * slot/why/prompt, cap at MAX_SPANS. Pure — exported for testing.
 * @param {any[]} parsed
 * @param {string} text
 */
function filterValidSpans(parsed, text) {
  const src = String(text || '');
  const seen = new Set();
  const spans = [];
  for (const s of Array.isArray(parsed) ? parsed : []) {
    if (!s || typeof s.excerpt !== 'string') continue;
    const excerpt = s.excerpt.trim();
    // Verbatim guarantee: the excerpt must exist in the post exactly, or the
    // frontend can't highlight it. Drop anything the model paraphrased.
    if (!excerpt || !src.includes(excerpt)) continue;
    if (seen.has(excerpt)) continue;
    seen.add(excerpt);
    spans.push({
      excerpt,
      slot:   VALID_SLOTS.has(s.slot) ? s.slot : 'bridge',
      why:    typeof s.why === 'string' ? s.why.trim().slice(0, 160) : '',
      prompt: typeof s.prompt === 'string' ? s.prompt.trim().slice(0, 200) : 'Say this in your own words.',
    });
    if (spans.length >= MAX_SPANS) break;
  }
  return spans;
}

module.exports = { suggestPersonalSpans, filterValidSpans };

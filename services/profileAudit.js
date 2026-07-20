'use strict';

/**
 * services/profileAudit.js — profile-as-landing-page audit (Authentic Client
 * Engine, Phase 5.4).
 *
 * A great post sends the right reader to the author's profile — and a vague
 * profile converts nobody. This scores a LinkedIn headline + About against the
 * author's ICP and offer, and returns concrete rewrites in their voice.
 *
 * The OAuth basic profile doesn't expose About text, so the user pastes it (a
 * 20-second copy). Fails soft — returns null result on any error.
 */

const { getSetting } = require('../db');
const { buildSharedAuthorContext } = require('./generationCore');

const SONNET_MODEL = 'claude-sonnet-4-6';

async function getClient() {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
}

/**
 * @param {object} args
 * @param {string} args.headline
 * @param {string} [args.about]
 * @param {object} [args.profile]  author profile (ICP + offer + voice context)
 * @returns {Promise<{ score, verdict, headline_rewrites, about_suggestions, next_step } | null>}
 */
async function auditProfile({ headline = '', about = '', profile = {} } = {}) {
  const head = (headline || '').trim();
  if (!head && !about.trim()) return null;

  const client = await getClient();
  if (!client) return null;

  const authorContext = buildSharedAuthorContext(profile, { includePhraseLibrary: false });

  const system = `You are a LinkedIn profile strategist auditing a founder's profile as a conversion surface — the page their posts send readers to.

${authorContext}

Judge the profile against THIS author's ideal audience and offer above. Be specific and honest, not flattering.

Return ONLY valid JSON:
{
  "score": 0-100 (how well the profile converts the RIGHT reader into a conversation),
  "verdict": "one blunt sentence on the biggest gap",
  "headline_rewrites": ["2-3 headline options in the author's voice that say who they help and to what outcome"],
  "about_suggestions": ["2-3 concrete, specific fixes to the About section — what to add, cut, or sharpen"],
  "next_step": "the single clearest call-to-action the profile should end with"
}
No markdown, no prose outside the JSON.`;

  const userParts = [`HEADLINE:\n${head || '(none provided)'}`];
  if (about.trim()) userParts.push(`ABOUT:\n${about.trim().slice(0, 2600)}`);

  let message;
  try {
    message = await client.messages.create({
      model: SONNET_MODEL,
      max_tokens: 900,
      temperature: 0.6,
      system,
      messages: [{ role: 'user', content: userParts.join('\n\n') }],
    });
  } catch (err) {
    console.error('[profileAudit] generation failed (non-fatal):', err.message);
    return null;
  }

  const raw = message.content.find(b => b.type === 'text')?.text?.trim() || '';
  return parseAudit(raw);
}

// Parse + sanitise the model output. Pure — exported for testing.
function parseAudit(raw) {
  let obj;
  try {
    const match = String(raw).match(/\{[\s\S]*\}/);
    obj = JSON.parse(match ? match[0] : raw);
  } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;

  const arr = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()).slice(0, 3) : []);
  let score = Number(obj.score);
  if (!Number.isFinite(score)) score = null;
  else score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    verdict:           typeof obj.verdict === 'string' ? obj.verdict.trim() : '',
    headline_rewrites: arr(obj.headline_rewrites),
    about_suggestions: arr(obj.about_suggestions),
    next_step:         typeof obj.next_step === 'string' ? obj.next_step.trim() : '',
  };
}

module.exports = { auditProfile, parseAudit };

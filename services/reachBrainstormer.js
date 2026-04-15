'use strict';

/**
 * reachBrainstormer.js — brainstorm reach-type LinkedIn post seed ideas from a topic.
 *
 * Unlike vault mining (which extracts insights from documents → trust/convert),
 * this generates reach ideas from a user-supplied topic: observations, hot takes,
 * contrarian angles, and relatable stories grounded in the user's niche.
 *
 * Quality is anchored by injecting the full user profile (niche, audience, contrarian
 * view, voice fingerprint) into the system prompt — same approach as ideaPath.js.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const { extractJsonFromResponse } = require('./voiceFingerprint');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 1500;
const TEMP       = 0.85; // slightly higher than ideaPath for creative variety

// Maps brainstormer angle labels → hook_archetype values used in vault_ideas
const ANGLE_TO_ARCHETYPE = {
  hot_take:    'CONTRARIAN',
  observation: 'INSIGHT',
  story:       'CONFESSION',
  contrarian:  'CONTRARIAN',
  relatable:   'DIRECT_ADDRESS',
  pattern:     'PATTERN_INTERRUPT',
};

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildFingerprintBlock(userProfile) {
  const fingerprint = userProfile.voice_fingerprint
    ? JSON.parse(userProfile.voice_fingerprint)
    : null;
  if (!fingerprint) return '';
  return `
VOICE (write seed ideas that feel native to this voice):
- Opening style: ${fingerprint.opening_style}
- Sentence structure: ${fingerprint.sentence_structure}
- Signature moves: ${fingerprint.signature_moves?.join(', ')}
`;
}

function buildSystemPrompt(userProfile) {
  const fingerprintBlock = buildFingerprintBlock(userProfile);
  const niche = userProfile.content_niche || 'their professional field';

  return `You are a reach content strategist for a ${niche} professional.
Your job is to brainstorm LinkedIn post ideas that maximise reach — broad enough to attract new audiences, specific enough to be credible in the niche.
${fingerprintBlock}
NICHE: ${niche}
AUDIENCE: ${userProfile.audience_role || 'professionals in the field'} — what keeps them up: ${userProfile.audience_pain || 'professional challenges in their field'}
EDITORIAL LENS: ${userProfile.contrarian_view || 'Challenge common assumptions with specificity.'}

Reach posts that perform well:
- State a specific observation others recognise but haven't articulated
- Challenge a common assumption in the niche with a defensible, specific take
- Tell a relatable story from real work with a surprising or honest turn
- Surface a pattern the audience experiences but has no name for
- Share a "hot take" that is specific to the niche, not vague platitudes

Do NOT produce:
- Generic advice ("here are 5 tips…")
- Ideas that could apply to any industry
- Vague openers ("I used to think…" with nothing concrete)

Every idea must be grounded in the ${niche} context.`;
}

function buildUserPrompt(topic) {
  return `TOPIC: ${topic}

Brainstorm exactly 6 reach-type LinkedIn post ideas about this topic.
Each must be a distinct angle — vary between: hot_take, observation, story, contrarian, relatable, pattern.

For each idea:
- seed_text: 1–2 sentences. Specific enough to write a full post from. No vague openers.
- angle: one of hot_take | observation | story | contrarian | relatable | pattern

Return ONLY a JSON array, no other text:
[{ "seed_text": "...", "angle": "..." }]`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Brainstorm 6 reach-type seed ideas for a given topic + user profile.
 *
 * @param {string} topic
 * @param {object} userProfile — row from user_profiles table
 * @returns {Promise<Array<{ seed_text: string, hook_archetype: string }>>}
 */
async function brainstorm(topic, userProfile) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMP,
    system:     buildSystemPrompt(userProfile),
    messages: [{ role: 'user', content: buildUserPrompt(topic) }],
  });

  const raw = response.content?.[0]?.text || '';
  const parsed = extractJsonFromResponse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error('Brainstormer returned unexpected format');
  }

  return parsed
    .filter(item => typeof item.seed_text === 'string' && item.seed_text.trim())
    .map(item => ({
      seed_text:      item.seed_text.trim(),
      hook_archetype: ANGLE_TO_ARCHETYPE[item.angle] || 'INSIGHT',
    }));
}

module.exports = { brainstorm };

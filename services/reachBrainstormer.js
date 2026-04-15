'use strict';

/**
 * reachBrainstormer.js — brainstorm reach-type LinkedIn post seed ideas from a topic.
 *
 * Unlike vault mining (which extracts insights from documents → trust/convert),
 * this generates reach ideas from a user-supplied topic: observations, hot takes,
 * contrarian angles, and relatable stories grounded in the user's niche.
 *
 * Quality pipeline (two passes):
 *   Pass 1 — Sonnet 4.6 generates 10 rough ideas with tension + anti-cliché guardrails.
 *   Pass 2 — Haiku 4.5 scores each idea against virality criteria and returns the top 6.
 *
 * Quality is anchored by injecting the full user profile (niche, audience, contrarian
 * view, voice fingerprint) into the system prompt — same approach as ideaPath.js.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const { extractJsonFromResponse } = require('./voiceFingerprint');

const SONNET_MODEL = 'claude-sonnet-4-6';
const HAIKU_MODEL  = 'claude-haiku-4-5-20251001';
const TEMP         = 0.85; // higher than ideaPath for creative variety

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
// Pass 1 — Sonnet: generate 10 rough ideas
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

Every idea MUST contain a tension — a contradiction, surprising reversal, or uncomfortable truth that makes the reader think "wait, that's not how I thought it worked." An idea without tension is just content.

Reach posts that perform well:
- Challenge a belief the audience currently holds, with a specific, defensible counter-take
- Name a pattern the audience experiences but has never seen articulated
- Tell a story from real work where the obvious approach failed and why
- State an observation that is specific enough to be surprising, not generic enough to be forgettable
- Surface an inconvenient truth the niche avoids talking about

Every seed_text must be anchored to at least one concrete detail — a specific number, timeframe, dollar amount, client scenario, or named situation. "Why client relationships fail" is forgettable. "Why I lost a $180k client on day 3" is not.

BANNED — these patterns are scroll-past clichés that kill reach:
- "Unpopular opinion:" as an opener
- "Here are N tips/lessons/things…" listicle framing
- "I used to think X. Now I know Y." without a specific, surprising Y
- "Most people think X, but actually X is fine" — non-take takes
- Generic motivation or hustle content with no niche specificity
- Any idea that could apply equally well to any industry
- Observations with no concrete anchor ("many people struggle with X")

Every idea must be rooted in the ${niche} context. Vague ideas are rejected.`;
}

function buildUserPrompt(topic) {
  return `TOPIC: ${topic}

Generate exactly 10 reach-type LinkedIn post ideas about this topic.
Each must be a distinct angle — vary between: hot_take, observation, story, contrarian, relatable, pattern.

Each idea MUST have an explicit tension — state it in the seed_text itself, not as a separate field.

For each idea:
- seed_text: 1–2 sentences. First sentence must function as a scroll-stopping hook. Specific, not generic.
- angle: one of hot_take | observation | story | contrarian | relatable | pattern

Return ONLY a JSON array, no other text:
[{ "seed_text": "...", "angle": "..." }]`;
}

// ---------------------------------------------------------------------------
// Pass 2 — Haiku: score and select top 6
// ---------------------------------------------------------------------------

const SCORING_SYSTEM = `You are a viral content editor. Score LinkedIn post ideas for reach potential.

Score each idea 1–10 on these criteria (equal weight):
1. tension_score: Does it contain a genuine contradiction, reversal, or uncomfortable truth?
2. specificity_score: Is it specific enough to be credible, or generic enough to be forgettable?
3. scroll_stop_score: Would the first sentence stop a scrolling reader cold?
4. novelty_score: Does it say something the audience hasn't heard a hundred times before?

Return ONLY a JSON array with scores and a combined total, sorted best-first. No other text.`;

function buildScoringPrompt(ideas) {
  const numbered = ideas.map((idea, i) => `${i}: ${idea.seed_text}`).join('\n');
  return `Score these ${ideas.length} LinkedIn post ideas and return the top 6 indices.

IDEAS:
${numbered}

Return ONLY a JSON array of the top 6 idea indices sorted best-first:
[{ "index": 0, "total": 36 }, ...]`;
}

async function scoreAndSelect(client, ideas) {
  if (ideas.length <= 6) return ideas;

  try {
    const response = await client.messages.create({
      model:      HAIKU_MODEL,
      max_tokens: 400,
      system:     SCORING_SYSTEM,
      messages:   [{ role: 'user', content: buildScoringPrompt(ideas) }],
    });

    const raw    = response.content?.[0]?.text || '';
    const scored = extractJsonFromResponse(raw);

    if (!Array.isArray(scored) || scored.length === 0) return ideas.slice(0, 6);

    return scored
      .slice(0, 6)
      .map(s => ideas[s.index])
      .filter(Boolean);
  } catch {
    // Non-fatal — fall back to first 6 if scoring fails
    return ideas.slice(0, 6);
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Brainstorm reach-type seed ideas for a given topic + user profile.
 * Pass 1: Sonnet generates 10 ideas with tension + anti-cliché guardrails.
 * Pass 2: Haiku scores and selects the top 6 by virality criteria.
 *
 * @param {string} topic
 * @param {object} userProfile — row from user_profiles table
 * @returns {Promise<Array<{ seed_text: string, hook_archetype: string }>>}
 */
async function brainstorm(topic, userProfile) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const client = new Anthropic({ apiKey });

  // Pass 1 — generate 10 rough ideas
  const genResponse = await client.messages.create({
    model:       SONNET_MODEL,
    max_tokens:  2000,
    temperature: TEMP,
    system:      buildSystemPrompt(userProfile),
    messages:    [{ role: 'user', content: buildUserPrompt(topic) }],
  });

  const raw    = genResponse.content?.[0]?.text || '';
  const parsed = extractJsonFromResponse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error('Brainstormer returned unexpected format');
  }

  const candidates = parsed
    .filter(item => typeof item.seed_text === 'string' && item.seed_text.trim())
    .map(item => ({
      seed_text:      item.seed_text.trim(),
      hook_archetype: ANGLE_TO_ARCHETYPE[item.angle] || 'INSIGHT',
    }));

  // Pass 2 — score and keep the top 6
  return scoreAndSelect(client, candidates);
}

module.exports = { brainstorm };

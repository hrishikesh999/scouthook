'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const { extractJsonFromResponse } = require('./voiceFingerprint');
const { selectHook, buildHookInjection } = require('./hookSelector');
const { HOOK_ARCHETYPES } = require('./hookArchetypes');

/**
 * Idea path: one LinkedIn post driven by the hook archetype from selectHook.
 * Uses claude-sonnet-4-6.
 *
 * @param {string} rawIdea
 * @param {object} userProfile
 * @param {object} [options]
 * @param {string} [options.qualityRetryHint]
 * @param {string} [options._regenerateHint]
 * @returns {Promise<{ synthesis: object, post: string, archetypeUsed: string, hookConfidence: number }>}
 */
async function ideaToPost(rawIdea, userProfile, options = {}) {
  const apiKey = getSetting('anthropic_api_key');
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const hookResult = await selectHook(rawIdea, userProfile);

  return runSinglePostGeneration({
    rawIdea,
    userProfile,
    options,
    hookInjection: hookResult.hookInjection,
    archetypeUsed: hookResult.archetype,
    hookConfidence: hookResult.confidence,
  });
}

/**
 * Second option when primary hook confidence is low: same raw idea, INSIGHT archetype structure only.
 *
 * @returns {Promise<{ synthesis: object, post: string, archetypeUsed: 'INSIGHT', hookConfidence: null }>}
 */
async function generateInsightAlternativePost(rawIdea, userProfile, options = {}) {
  const apiKey = getSetting('anthropic_api_key');
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const insightInjection = buildHookInjection(HOOK_ARCHETYPES.INSIGHT);

  const result = await runSinglePostGeneration({
    rawIdea,
    userProfile,
    options,
    hookInjection: insightInjection,
    archetypeUsed: 'INSIGHT',
    hookConfidence: null,
  });

  return {
    ...result,
    archetypeUsed: 'INSIGHT',
    hookConfidence: null,
  };
}

function buildFingerprintBlock(userProfile) {
  const fingerprint = userProfile.voice_fingerprint
    ? JSON.parse(userProfile.voice_fingerprint)
    : null;
  if (!fingerprint) return '';
  return `
VOICE FINGERPRINT (strictly follow these patterns):
- Opening style: ${fingerprint.opening_style}
- Sentence structure: ${fingerprint.sentence_structure}
- Credibility mechanism: ${fingerprint.credibility_mechanism}
- Signature moves: ${fingerprint.signature_moves?.join(', ')}
`;
}

function buildSystemPrompt(userProfile, hookInjectionBlock) {
  const fingerprintBlock = buildFingerprintBlock(userProfile);
  return `You are an editorial thinking partner for a professional who creates LinkedIn content. Your job is to take a raw idea and transform it into one polished, high-quality LinkedIn post that sounds exactly like the author — not like AI.

Produce exactly **one** post. The structure and opening of that post are determined entirely by the HOOK ARCHETYPE and HOOK INSTRUCTION below. Do not follow any other named format (no "stat hook", "hot take", or "story" templates).

${fingerprintBlock}
${hookInjectionBlock}

CONTENT NICHE: ${userProfile.content_niche || 'not specified'}

AUDIENCE:
- Who they are: ${userProfile.audience_role || 'professionals in the author\'s field'}
- What keeps them up at night: ${userProfile.audience_pain || 'professional challenges in their field'}

EDITORIAL CONTEXT (use where it strengthens the post):
${userProfile.contrarian_view || 'Draw on the raw idea for tension and specificity.'}`;
}

function buildUserPrompt(rawIdea) {
  return `RAW IDEA:
${rawIdea}

Return ONLY valid JSON in this exact structure:
{
  "synthesis": {
    "suggested_angle": "one sentence on the strongest angle for this idea",
    "recommended_structure": "one sentence on the best structure given the audience",
    "supporting_insight": "one sentence of editorial context that makes this idea stronger"
  },
  "post": "full text of the single LinkedIn post"
}

No markdown fences. No explanation. Only the JSON object.`;
}

async function runSinglePostGeneration({
  rawIdea,
  userProfile,
  options,
  hookInjection,
  archetypeUsed,
  hookConfidence,
}) {
  const client = new Anthropic({ apiKey: getSetting('anthropic_api_key') });

  const systemPrompt = buildSystemPrompt(userProfile, hookInjection);
  let userPrompt = buildUserPrompt(rawIdea);

  const extraHints = [
    options.qualityRetryHint,
    options._regenerateHint,
  ].filter(Boolean).join('\n\n');
  const userPromptFinal = extraHints ? `${userPrompt}\n\n${extraHints}` : userPrompt;

  let responseText = '';

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPromptFinal }],
    });

    responseText = message.content[0]?.text?.trim() || '';
    const validated = validateSinglePostResponse(extractJsonFromResponse(responseText));
    return {
      synthesis: validated.synthesis,
      post: validated.post,
      archetypeUsed,
      hookConfidence,
    };
  } catch (firstErr) {
    if (firstErr instanceof SyntaxError && responseText) {
      try {
        const retry = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 3000,
          temperature: 0.7,
          system: systemPrompt,
          messages: [
            { role: 'user', content: userPromptFinal },
            { role: 'assistant', content: responseText },
            { role: 'user', content: 'Return only valid JSON, no other text.' },
          ],
        });
        responseText = retry.content[0]?.text?.trim() || '';
        const validated = validateSinglePostResponse(extractJsonFromResponse(responseText));
        return {
          synthesis: validated.synthesis,
          post: validated.post,
          archetypeUsed,
          hookConfidence,
        };
      } catch (retryErr) {
        throw new Error(`Generation failed after retry: ${retryErr.message}`);
      }
    }
    throw firstErr;
  }
}

function validateSinglePostResponse(parsed) {
  if (!parsed.synthesis || typeof parsed.post !== 'string' || !parsed.post.trim()) {
    throw new SyntaxError('Response missing synthesis or post string');
  }
  const s = parsed.synthesis;
  if (!s.suggested_angle || !s.recommended_structure || !s.supporting_insight) {
    throw new SyntaxError('Response synthesis missing required fields');
  }
  return { synthesis: parsed.synthesis, post: parsed.post.trim() };
}

module.exports = { ideaToPost, generateInsightAlternativePost };

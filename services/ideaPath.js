'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const { extractJsonFromResponse } = require('./voiceFingerprint');
const { selectHook, buildHookInjection } = require('./hookSelector');
const { HOOK_ARCHETYPES } = require('./hookArchetypes');
const { AI_TELLS_PROHIBITION, sanitiseAiTells } = require('./postSanitiser');
const { LINKEDIN_RULES } = require('../modules/formatIntelligence/rules');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

function getLengthGuidance(funnelType) {
  const targets = LINKEDIN_RULES.postLengthTargets;
  return (targets[funnelType] || targets.default).guidance;
}

/**
 * Generate a single alternative first line (hook B) using Haiku.
 * Gives the user a second hook option without regenerating the whole post.
 * Returns null on any failure — hook B is always non-blocking.
 */
async function generateAlternativeHook(post, usedArchetype, client) {
  try {
    const response = await client.messages.create({
      model:      HAIKU_MODEL,
      max_tokens: 80,
      system:     'You are a LinkedIn hook writer. Write one alternative opening line for a post. Under 12 words. No explanation. Plain text only.',
      messages:   [{
        role:    'user',
        content: `This post opens with a ${usedArchetype} hook:\n\n${post.split('\n').slice(0, 3).join('\n')}\n\nWrite one alternative first line using a completely different angle. Make it punchy, specific, and scroll-stopping. Plain text only — no quotes, no labels.`,
      }],
    });
    const line = response.content?.[0]?.text?.trim() || null;
    return line && line.length > 0 ? line : null;
  } catch {
    return null; // non-blocking
  }
}

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
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
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
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
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

function buildCtaInstruction(funnelType, ctaHint) {
  const funnelInstructions = {
    reach:   "End with one specific question inviting the reader to share their own experience with the post's central tension. Specific beats vague — 'What did you do when X happened?' beats 'What do you think?' Do NOT use 'Thoughts?' or 'What do you think?' verbatim.",
    trust:   "End with a reflection question that challenges the reader to examine their own practice, OR a forward-facing declarative that cements your authority position. The close should feel earned, not appended.",
    convert: "End with a soft, one-line conversion invite — offer to DM, mention a resource in the comments, or invite them to follow for more. One ask only. Keep it conversational. No 'Check out my link' phrasing.",
  };
  const funnelInstruction = funnelInstructions[funnelType] || funnelInstructions.trust;
  const hintLine = ctaHint ? `\nARCHETYPE CTA DIRECTION: ${ctaHint}` : '';
  return `\nCLOSING:
${funnelInstruction}${hintLine}`;
}

function buildSystemPrompt(userProfile, hookInjectionBlock, ctaInstruction = '') {
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
${userProfile.contrarian_view || 'Draw on the raw idea for tension and specificity.'}

LINKEDIN FORMATTING (non-negotiable):
- One sentence per line. Never write paragraph blocks. Every sentence gets its own line.
- Put a blank line between every 2–3 lines to create visual breathing room.
- The post must be visually scannable — a wall of text kills engagement before anyone reads it.

ABOVE THE FOLD (critical for reach):
- LinkedIn shows only the first 2–3 lines before the "see more" truncation.
- Line 1 is the hook — handled by the archetype instruction above.
- Lines 2–3 must deepen the tension from the hook, not explain or contextualise it.
- Lines 2–3 should make the reader feel they will miss something if they do not click "see more".
- Never use lines 2–3 for background, setup, or "let me tell you about X" framing.
${AI_TELLS_PROHIBITION}${ctaInstruction}`;
}

function buildUserPrompt(rawIdea) {
  return `RAW IDEA:
${rawIdea}

EXTRACTION INSTRUCTION: Before structuring the post, identify the most specific experience, result, or data point in the raw idea. If the input is too vague (no concrete outcome, no opinion, no specific moment), ground the post in a plausible but clearly author-attributed specific scenario rather than staying at the level of the vague input.

LENGTH: ${getLengthGuidance('default')}

Return ONLY valid JSON in this exact structure:
{
  "synthesis": {
    "suggested_angle": "one sentence on the strongest angle for this idea",
    "recommended_structure": "one sentence on the best structure given the audience",
    "supporting_insight": "one sentence of editorial context that makes this idea stronger"
  },
  "post": "full text of the single LinkedIn post",
  "cta_alternatives": [
    "one alternative closing line — different question angle or engagement prompt",
    "one alternative closing line — soft conversion invite (DM, follow, or resource in comments)"
  ]
}

No markdown fences. No explanation. Only the JSON object.`;
}

/**
 * User prompt for trust/convert vault posts. Frames the input as expert source material
 * so Claude preserves depth and specificity rather than genericising.
 */
function buildVaultUserPrompt(vaultIdea, chunkText) {
  const sourceNote = vaultIdea.source_ref ? `\nSOURCE: ${vaultIdea.source_ref}` : '';

  const chunkSection = chunkText
    ? `\n\nORIGINAL PASSAGE (the source text this insight was extracted from — draw on it to preserve depth and specificity):\n${chunkText.slice(0, 2000)}`
    : '';

  return `VAULT SEED (distilled insight from the author's own expert source material):
${vaultIdea.seed_text}${sourceNote}${chunkSection}

This insight was mined from the author's own documents. Expand it into a LinkedIn post that:
- Preserves the depth, specificity, and any proprietary framing from the source
- Does NOT genericise, water down, or replace concrete details with vague language
- Reads as the author sharing hard-won, specific knowledge — not a summary of it

LENGTH: ${getLengthGuidance(vaultIdea.funnel_type)}

Return ONLY valid JSON in this exact structure:
{
  "synthesis": {
    "suggested_angle": "one sentence on the strongest angle for this idea",
    "recommended_structure": "one sentence on the best structure given the audience",
    "supporting_insight": "one sentence of editorial context that makes this idea stronger"
  },
  "post": "full text of the single LinkedIn post",
  "cta_alternatives": [
    "one alternative closing line — different question angle or engagement prompt",
    "one alternative closing line — soft conversion invite (DM, follow, or resource in comments)"
  ]
}

No markdown fences. No explanation. Only the JSON object.`;
}

/**
 * User prompt for reach vault posts. Frames the input as an angle or observation
 * to develop into a broad, relatable post — not expert material to preserve.
 */
function buildReachUserPrompt(vaultIdea) {
  return `REACH ANGLE:
${vaultIdea.seed_text}

Develop this into a LinkedIn post optimised for reach — designed to attract new audiences and spark broad engagement.

A reach post works by making the reader feel seen, surprised, or compelled to respond. It succeeds through resonance, not credentials.

Write a post that:
- Opens with a hook that stops the scroll — a tension, contradiction, or observation the reader instantly recognises
- Stays relatable and human throughout — no jargon, no credentials-flaunting, no listicle structure
- Has a clear point of view; does not hedge or stay neutral
- Sounds like a person talking, not a professional presenting
- Does NOT lecture, summarise, or explain — it provokes and connects

LENGTH: ${getLengthGuidance('reach')}

Return ONLY valid JSON in this exact structure:
{
  "synthesis": {
    "suggested_angle": "one sentence on the strongest angle for this idea",
    "recommended_structure": "one sentence on the best structure given the audience",
    "supporting_insight": "one sentence of editorial context that makes this idea stronger"
  },
  "post": "full text of the single LinkedIn post",
  "cta_alternatives": [
    "one alternative closing line — different question angle or engagement prompt",
    "one alternative closing line — soft conversion invite (DM, follow, or resource in comments)"
  ]
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
  userPromptOverride,
  funnelType = null,
}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');
  const client = new Anthropic({ apiKey });

  const ctaHint = HOOK_ARCHETYPES[archetypeUsed]?.ctaHint || null;
  const ctaInstruction = buildCtaInstruction(funnelType, ctaHint);
  const systemPrompt = buildSystemPrompt(userProfile, hookInjection, ctaInstruction);
  let userPrompt = userPromptOverride || buildUserPrompt(rawIdea);

  const extraHints = [
    options._funnelHint,
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
    const cleanPost = sanitiseAiTells(validated.post);
    const hookB = await generateAlternativeHook(cleanPost, archetypeUsed, client);
    return {
      synthesis:       validated.synthesis,
      post:            cleanPost,
      hookB,
      ctaAlternatives: validated.ctaAlternatives,
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
        const cleanPost = sanitiseAiTells(validated.post);
        const hookB = await generateAlternativeHook(cleanPost, archetypeUsed, client);
        return {
          synthesis:       validated.synthesis,
          post:            cleanPost,
          hookB,
          ctaAlternatives: validated.ctaAlternatives,
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
  const ctaAlternatives = Array.isArray(parsed.cta_alternatives)
    ? parsed.cta_alternatives.filter(l => typeof l === 'string' && l.trim()).slice(0, 2)
    : [];
  return { synthesis: parsed.synthesis, post: parsed.post.trim(), ctaAlternatives };
}

/**
 * Vault path: generate a LinkedIn post from a pre-classified vault seed.
 *
 * Differences from ideaToPost:
 * - Skips Haiku hook reclassification — uses stored hook_archetype directly.
 * - Uses buildVaultUserPrompt so Claude knows the input is expert source material.
 * - Optionally includes the original chunk text for deeper context.
 *
 * @param {object} vaultIdea  — row from vault_ideas (seed_text, hook_archetype, funnel_type, source_ref)
 * @param {string|null} chunkText — raw text of the source chunk, or null
 * @param {object} userProfile
 * @param {object} [options]
 */
async function vaultSeedToPost(vaultIdea, chunkText, userProfile, options = {}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const archetype = vaultIdea.hook_archetype || 'INSIGHT';
  const archetypeRecord = HOOK_ARCHETYPES[archetype] || HOOK_ARCHETYPES.INSIGHT;
  const hookInjection = buildHookInjection(archetypeRecord);

  // Reach ideas have no source document — use a prompt focused on resonance and
  // relatability rather than depth/specificity preservation.
  const userPromptOverride = vaultIdea.funnel_type === 'reach'
    ? buildReachUserPrompt(vaultIdea)
    : buildVaultUserPrompt(vaultIdea, chunkText);

  return runSinglePostGeneration({
    rawIdea: vaultIdea.seed_text,   // used only for quality-retry hint text
    userProfile,
    options,
    hookInjection,
    archetypeUsed: archetype,
    hookConfidence: 1.0,            // pre-classified; treat as high confidence
    userPromptOverride,
    funnelType: vaultIdea.funnel_type || null,
  });
}

module.exports = { ideaToPost, generateInsightAlternativePost, vaultSeedToPost };

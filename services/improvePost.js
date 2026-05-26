'use strict';

/**
 * Improve an existing post using targeted, flag-driven fixes.
 *
 * Token efficiency strategy:
 * - Haiku model: ~12x cheaper than Sonnet
 * - System prompt cached via prompt-caching-2024-07-31 beta
 * - No discovery phase: quality-gate flags already identify exact problems
 * - runQualityGate is rule-based (zero AI tokens) — rescore is free
 * - Single API call regardless of how many dimensions need fixing
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const { buildVoiceDNABlock } = require('./voiceExtraction');
const { AI_TELLS_PROHIBITION, sanitiseAiTells } = require('./postSanitiser');
const { runQualityGate } = require('./qualityGate');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// Each entry maps a quality-gate flag to a surgical fix instruction.
// Instructions are intentionally narrow: tell the model exactly what to touch.
const FLAG_FIX_MAP = {
  WEAK_HOOK_OPENER:
    'HOOK: The opening line uses a weak starter. Rewrite ONLY the first line to open with a specific outcome, number, or contradiction. Under 12 words. Leave every other line unchanged.',
  HOOK_TOO_LONG:
    'HOOK: The opening line is too long. Compress ONLY the first line to under 12 words by removing filler — keep its meaning.',
  GENERIC_HOOK:
    'HOOK: The opening feels generic. Make the first line specific to the exact story in this post — use a concrete detail, number, or role already present.',
  AI_LANGUAGE_DETECTED:
    'VOICE: Replace all AI-giveaway vocabulary (delve, leverage, empower, elevate, robust, seamless, multifaceted, nuanced, pivotal, foster, showcase, etc.) with plain, direct language. Do not change any facts or numbers.',
  AI_TONE:
    'VOICE: Remove AI filler transitions ("it\'s worth noting", "at the end of the day", "ultimately", "in essence", "that said"). Restructure those sentences to be direct without the filler.',
  VOICE_DRIFT:
    'VOICE: Adjust tone to match the Voice DNA profile provided above. Keep all facts and numbers unchanged.',
  CLICHE_DETECTED:
    'SUBSTANCE: Replace overused phrases with specific, concrete alternatives drawn only from what is already stated in the post. Do not invent new claims.',
  LACKS_SPECIFICITY:
    'SUBSTANCE: The post is vague. Replace the vaguest statement with a more concrete version using only details that are already implied or present — do not invent statistics or outcomes.',
  NO_CTA:
    'ENGAGEMENT: Add a closing question specific to the exact scenario or tension in this post. Not "what do you think?" — make it about the specific situation described.',
  WEAK_CTA:
    'ENGAGEMENT: The closing question is too generic. Rewrite it to ask something specific to the exact situation or decision described in this post.',
  TOO_LONG:
    'STRUCTURE: Remove the weakest paragraph — the one that repeats another point or adds the least. Do not change any other paragraph.',
  DENSE_FORMATTING:
    'STRUCTURE: Break any paragraph longer than 3 sentences into single-sentence lines. Put a blank line between every 2–3 lines.',
  HASHTAG_SPAM:
    'STRUCTURE: Remove all hashtags from the post.',
};

// Static rules included in every cached system prompt.
// Comprehensive enough to push total system prompt over the 1024-token cache minimum.
const EDITOR_STATIC = `You are a LinkedIn post editor making targeted, surgical fixes.

ABSOLUTE EDITING RULES:
1. Never invent facts, statistics, names, results, or timeframes not already in the post
2. Never change the core argument, story, or position
3. Preserve all specific details (numbers, names, timeframes) exactly as written
4. Fix only the diagnosed issues — leave everything else unchanged
5. Output valid JSON only: {"post": "...", "changed": true/false}
6. If nothing needed changing, set changed to false and return the original post verbatim

LINKEDIN FORMAT RULES (enforce even if not in the diagnosis):
- One sentence per line. Never write paragraph blocks.
- Put a blank line between every 2–3 lines for visual breathing room.
- No em dashes (—). Use a comma, a period, or restructure the sentence.
- No numbered lists (1. 2. 3.) — use unequal-weight line breaks instead.
- No lesson summaries: "In conclusion", "To summarize", "Here's the lesson", "The takeaway is", "The bottom line".
- No generic CTAs: "What do you think? Let me know in the comments." — closing must be specific to this post.
- No engagement bait: "Comment YES", "Tag someone", "Type 1 for...", "Repost if you agree".
- Never end with a "both sides" conclusion — the post must take a position.

CONVICTION RULES:
- Never hedge a position with "might", "may", "perhaps", "potentially" when stating a claim
- Never use "some people", "many people" — say what you observe directly
- Never use "in many cases", "it depends" as a conclusion

`;

function buildSystemPrompt(userProfile) {
  const voiceDNA = buildVoiceDNABlock(userProfile);
  return EDITOR_STATIC
    + (voiceDNA ? voiceDNA + '\n\n' : '')
    + AI_TELLS_PROHIBITION;
}

function buildFixInstructions(flags) {
  const fixes = flags.map(f => FLAG_FIX_MAP[f]).filter(Boolean);
  if (!fixes.length) {
    return 'No critical issues detected. Apply light polish only if it clearly improves quality — otherwise return the post unchanged with changed: false.';
  }
  return 'FIXES TO APPLY (apply all, in order):\n'
    + fixes.map((f, i) => `${i + 1}. ${f}`).join('\n');
}

/**
 * @param {string}   postContent   Current post text
 * @param {string[]} flags         Quality-gate flags from the last runQualityGate call
 * @param {object}   userProfile   Row from user_profiles (needs voice_fingerprint etc.)
 * @param {object}   [options]
 * @param {string}   [options.funnelType]
 * @param {string}   [options.formatSlug]
 * @returns {Promise<{post, changed, quality, _usage}>}
 */
async function improvePost(postContent, flags, userProfile, options = {}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim()
    || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const client = new Anthropic({ apiKey });

  const systemPrompt    = buildSystemPrompt(userProfile);
  const fixInstructions = buildFixInstructions(flags);
  const userMessage     = `CURRENT POST:\n${postContent}\n\n${fixInstructions}\n\nOutput JSON only: {"post": "...", "changed": true}`;

  // System prompt is cached — Voice DNA is stable per user within a session.
  // Cache invalidates only when Voice DNA changes (rare).
  // Haiku minimum for caching: 1024 tokens — our system prompt is safely over that.
  const message = await client.beta.messages.create({
    model:      HAIKU_MODEL,
    max_tokens: 750,
    betas:      ['prompt-caching-2024-07-31'],
    system: [
      {
        type:          'text',
        text:          systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
  });

  const raw = message.content?.[0]?.text?.trim() || '';

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match?.[0] || raw);
  } catch {
    parsed = { post: postContent, changed: false };
  }

  const improved = sanitiseAiTells(
    typeof parsed.post === 'string' && parsed.post.length > 20
      ? parsed.post
      : postContent
  );

  // Rescore with runQualityGate — pure rule-based, zero additional API tokens
  const gate = runQualityGate(improved, {
    voiceProfile: userProfile,
    formatSlug:   options.formatSlug  || null,
    funnelType:   options.funnelType  || null,
    path:         'improve',
  });

  return {
    post:    improved,
    changed: parsed.changed !== false && improved !== postContent,
    quality: {
      score:      gate.score,
      passed:     gate.passed,
      flags:      gate.flags,
      errors:     gate.errors,
      warnings:   gate.warnings,
      dimensions: gate.dimensions,
      verdict:    gate.verdict,
    },
    // Exposed for server-side logging only — not sent to client
    _usage: {
      input_tokens:                  message.usage?.input_tokens                  ?? 0,
      output_tokens:                 message.usage?.output_tokens                 ?? 0,
      cache_creation_input_tokens:   message.usage?.cache_creation_input_tokens   ?? 0,
      cache_read_input_tokens:       message.usage?.cache_read_input_tokens        ?? 0,
    },
  };
}

module.exports = { improvePost };

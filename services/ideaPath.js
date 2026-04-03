'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { db, getSetting } = require('../db');
const { extractJsonFromResponse } = require('./voiceFingerprint');

/**
 * Idea path: takes a raw idea and a user profile, returns synthesis + 3 posts.
 * Uses claude-sonnet-4-6 — complex reasoning required.
 *
 * @param {string} rawIdea — user's raw idea text
 * @param {object} userProfile — full profile row (voice_fingerprint is a JSON string)
 * @returns {Promise<{ synthesis: { suggested_angle, recommended_structure, supporting_insight }, posts: Array }>}
 */
async function ideaToPost(rawIdea, userProfile) {
  const apiKey = getSetting('anthropic_api_key');
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const client = new Anthropic({ apiKey });

  // Load post formats from DB — never hardcode
  const formats = db
    .prepare("SELECT slug, name, prompt_instructions FROM post_formats WHERE is_active = 1 AND tenant_id = ? ORDER BY sort_order")
    .all(userProfile.tenant_id || 'default');

  if (!formats.length) throw new Error('No active post formats found in database');

  const fingerprint = userProfile.voice_fingerprint
    ? JSON.parse(userProfile.voice_fingerprint)
    : null;

  const fingerprintBlock = fingerprint ? `
VOICE FINGERPRINT (strictly follow these patterns):
- Opening style: ${fingerprint.opening_style}
- Sentence structure: ${fingerprint.sentence_structure}
- Credibility mechanism: ${fingerprint.credibility_mechanism}
- Signature moves: ${fingerprint.signature_moves?.join(', ')}
` : '';

  const formatsBlock = formats.map(f =>
    `FORMAT: ${f.slug}\nName: ${f.name}\nInstructions: ${f.prompt_instructions}`
  ).join('\n\n');

  const systemPrompt = `You are an editorial thinking partner for a professional who creates LinkedIn content. Your job is to take a raw idea and transform it into polished, high-quality LinkedIn posts that sound exactly like the author — not like AI.

You will produce 3 posts, one in each format. Each post must be genuinely different: different opening line, different angle, different structure. The audience should not be able to tell they came from the same source.

${fingerprintBlock}
AUDIENCE:
- Who they are: ${userProfile.audience_role || 'professionals in the author\'s field'}
- What keeps them up at night: ${userProfile.audience_pain || 'professional challenges in their field'}

CONTRARIAN POSITION (use verbatim in hot_take format):
${userProfile.contrarian_view || 'Draw on the idea itself for the contrarian angle.'}`;

  const userPrompt = `RAW IDEA:
${rawIdea}

POST FORMATS TO USE:
${formatsBlock}

Produce exactly 3 posts. Return ONLY valid JSON in this exact structure:
{
  "synthesis": {
    "suggested_angle": "one sentence on the strongest angle for this idea",
    "recommended_structure": "one sentence on the best structure given the audience",
    "supporting_insight": "one sentence of editorial context that makes this idea stronger"
  },
  "posts": [
    { "format_slug": "stat_hook", "content": "full post text" },
    { "format_slug": "hot_take", "content": "full post text" },
    { "format_slug": "story", "content": "full post text" }
  ]
}

No markdown fences. No explanation. Only the JSON object.`;

  let responseText = '';

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    responseText = message.content[0]?.text?.trim() || '';
    return validateGenerationResponse(extractJsonFromResponse(responseText), formats);
  } catch (firstErr) {
    if (firstErr instanceof SyntaxError && responseText) {
      // Retry once
      try {
        const retry = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 3000,
          temperature: 0.7,
          system: systemPrompt,
          messages: [
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: responseText },
            { role: 'user', content: 'Return only valid JSON, no other text.' },
          ],
        });
        responseText = retry.content[0]?.text?.trim() || '';
        return validateGenerationResponse(extractJsonFromResponse(responseText), formats);
      } catch (retryErr) {
        throw new Error(`Generation failed after retry: ${retryErr.message}`);
      }
    }
    throw firstErr;
  }
}

function validateGenerationResponse(parsed, formats) {
  if (!parsed.synthesis || !parsed.posts || !Array.isArray(parsed.posts)) {
    throw new SyntaxError('Response missing synthesis or posts array');
  }
  const slugSet = new Set(formats.map(f => f.slug));
  for (const post of parsed.posts) {
    if (!post.format_slug || !post.content) throw new SyntaxError('Post missing format_slug or content');
    if (!slugSet.has(post.format_slug)) throw new SyntaxError(`Unknown format_slug: ${post.format_slug}`);
  }
  return parsed;
}

module.exports = { ideaToPost };

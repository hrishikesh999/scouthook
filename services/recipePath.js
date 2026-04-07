'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { db, getSetting } = require('../db');
const { extractJsonFromResponse } = require('./voiceFingerprint');
const { AI_TELLS_PROHIBITION, sanitiseAiTells } = require('./postSanitiser');

/**
 * Recipe path: takes a recipe slug + user answers + user profile.
 * Returns synthesis + posts for ONLY the recipe's suitable_formats.
 * Recipe config is loaded from DB — never hardcoded.
 * The user's answers ARE the research — Claude shapes them, not supplements them.
 *
 * @param {string} recipeSlug — slug from recipes table
 * @param {string[]} answers — array of answer strings, indexed by question order
 * @param {object} userProfile — full profile row (includes voice_fingerprint JSON string)
 * @param {object} [options]
 * @param {string} [options.qualityRetryHint]
 * @param {string} [options._regenerateHint]
 * @returns {Promise<{ synthesis, posts: Array }>}
 */
async function recipesToPost(recipeSlug, answers, userProfile, options = {}) {
  const apiKey = getSetting('anthropic_api_key');
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const tenantId = userProfile.tenant_id || 'default';

  // Load recipe from DB — never hardcode
  const recipe = db
    .prepare('SELECT * FROM recipes WHERE slug = ? AND tenant_id = ? AND is_active = 1')
    .get(recipeSlug, tenantId);

  if (!recipe) throw new Error(`Recipe not found: ${recipeSlug}`);

  const questions = JSON.parse(recipe.questions);
  const suitableFormats = JSON.parse(recipe.suitable_formats || '[]');

  if (!suitableFormats.length) throw new Error(`Recipe ${recipeSlug} has no suitable_formats`);

  // Load only the suitable formats from DB
  const placeholders = suitableFormats.map(() => '?').join(',');
  const formats = db.prepare(`
    SELECT slug, name, prompt_instructions
    FROM post_formats
    WHERE slug IN (${placeholders}) AND tenant_id = ? AND is_active = 1
    ORDER BY sort_order
  `).all(...suitableFormats, tenantId);

  if (!formats.length) throw new Error('No active post formats found for this recipe');

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

  // Build Q&A block — pair each question with the user's answer
  const qaBlock = questions.map((q, i) => {
    const answer = (answers[i] || '').trim();
    return `Q: ${q}\nA: ${answer || '(not answered)'}`;
  }).join('\n\n');

  const formatsBlock = formats.map(f =>
    `FORMAT: ${f.slug}\nName: ${f.name}\nInstructions: ${f.prompt_instructions}`
  ).join('\n\n');

  const systemPrompt = `You are an expert LinkedIn ghostwriter helping a professional turn their real experience into high-quality LinkedIn posts.

The user has answered a set of guided questions. Their answers are the raw material. Your job is to shape those answers into polished posts that sound exactly like them — not like AI, not like a template.

Critical rules:
- The posts must be grounded entirely in what the user actually said. Do not invent facts, statistics, or experiences they did not mention.
- Use the voice fingerprint strictly. The reader should not be able to tell this was AI-assisted.
- Each post must have a distinct opening line, angle, and structure — they should not feel like variations of the same draft.
- No hashtags. No emojis. No AI filler phrases.
${AI_TELLS_PROHIBITION}
${fingerprintBlock}
AUDIENCE:
- Who they are: ${userProfile.audience_role || 'professionals in the author\'s field'}
- What keeps them up at night: ${userProfile.audience_pain || 'professional challenges in their field'}`;

  const userPrompt = `RECIPE: ${recipe.name}

USER'S ANSWERS:
${qaBlock}

POST FORMATS TO USE (generate one post per format below — no more, no less):
${formatsBlock}

Return ONLY valid JSON in this exact structure:
{
  "synthesis": {
    "suggested_angle": "one sentence on the strongest angle emerging from these answers",
    "recommended_structure": "one sentence on the best structure given the audience",
    "supporting_insight": "one sentence of editorial context that strengthens the post"
  },
  "posts": [
    { "format_slug": "<slug>", "content": "full post text" }
  ]
}

No markdown fences. No explanation. Only the JSON object.`;

  const extraHints = [
    options.qualityRetryHint,
    options._regenerateHint,
  ].filter(Boolean).join('\n\n');
  const userPromptFinal = extraHints ? `${userPrompt}\n\n${extraHints}` : userPrompt;

  const client = new Anthropic({ apiKey });
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
    return validateResponse(extractJsonFromResponse(responseText), formats);
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
        return validateResponse(extractJsonFromResponse(responseText), formats);
      } catch (retryErr) {
        throw new Error(`Recipe generation failed after retry: ${retryErr.message}`);
      }
    }
    throw firstErr;
  }
}

function validateResponse(parsed, formats) {
  if (!parsed.synthesis || !parsed.posts || !Array.isArray(parsed.posts)) {
    throw new SyntaxError('Response missing synthesis or posts array');
  }
  const slugSet = new Set(formats.map(f => f.slug));
  for (const post of parsed.posts) {
    if (!post.format_slug || !post.content) throw new SyntaxError('Post missing format_slug or content');
    if (!slugSet.has(post.format_slug)) throw new SyntaxError(`Unexpected format_slug: ${post.format_slug}`);
    post.content = sanitiseAiTells(post.content);
  }
  return parsed;
}

module.exports = { recipesToPost };

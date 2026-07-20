'use strict';

/**
 * services/postEngine.js — the single generation engine behind all 10 guided
 * post types. Replaces 10 near-identical services/*Path.js generators.
 *
 * Assembles one system prompt from shared parts:
 *   base role (author's voice, no persona)
 *   + recipe.structureGuide (the only type-specific text)
 *   + shared author context (Voice DNA, phrase library, published examples)
 *   + authenticity core (craft rules + AI-tell prohibition + specificity mandate)
 *   + length / CTA / output rules
 *
 * Notable differences from the old per-type services:
 *   - No "Justin Welsh" persona.       - No mandated hashtags (OUTPUT forbids them).
 *   - Authenticity core injected.      - temperature 0.8 (was SDK default 1.0).
 *   - Prompt-prefix cache_control.     - Output passed through sanitiseAiTells().
 *
 * See sprint-authenticity-pipeline.md (Phase 2).
 */

const Anthropic = require('@anthropic-ai/sdk');
const { db, getSetting } = require('../db');
const { getRecipe } = require('./postRecipes');
const { buildAuthenticityCore, buildSharedAuthorContext, sanitiseAiTells, classifyHookShape } = require('./generationCore');
const { fetchPublishedExamples } = require('./ideaPath');

// Anti-repetition (Authentic Client Engine, Phase 6): when the author's two most
// recent posts opened with the same hook shape, tell the model to open this one
// differently. Placed in the USER prompt (not the cached system prefix) so it
// never invalidates the prompt cache. Returns '' when there's no repetition.
function firstLineOf(content) {
  return (String(content || '').split('\n').map(s => s.trim()).find(Boolean) || '').slice(0, 80);
}

async function buildHookAvoidance(profileId) {
  if (!profileId) return '';
  try {
    const rows = await db.prepare(`
      SELECT content, hook_shape FROM generated_posts
      WHERE  profile_id = ? AND content IS NOT NULL
        AND  status IN ('published', 'scheduled', 'draft')
      ORDER  BY created_at DESC
      LIMIT  3
    `).all(profileId);
    if (rows.length < 2) return '';
    // Fall back to on-the-fly classification for rows stamped before Phase 6.
    const shapeOf = r => r.hook_shape || classifyHookShape(r.content);
    const s0 = shapeOf(rows[0]);
    const s1 = shapeOf(rows[1]);
    if (!s0 || s0 !== s1) return '';
    const lines = rows.map(r => `- [${shapeOf(r)}] "${firstLineOf(r.content)}"`).join('\n');
    return `RECENT HOOKS (the author's last posts all opened the same way — do NOT reuse these shapes or rhythms):\n${lines}\nOpen this post with a different kind of first line.`;
  } catch { return ''; }
}

const SONNET_MODEL = 'claude-sonnet-4-6';

const BASE_ROLE = `You are ghostwriting a single LinkedIn post for a specific professional.
Write in THEIR voice — the way this particular person actually talks — not a generic LinkedIn influencer voice.
You have full authority over the hook, structure, and phrasing within the guidance below.`;

const LENGTH_GUIDANCE = `LENGTH: Treat POST LENGTH as creative direction, not a hard limit.
- Short: tight and punchy, one idea.
- Medium: room to develop the idea, no padding.
- Long: a fuller treatment where every sentence still earns its place.`;

const CTA_HANDLING = `CTA HANDLING:
A CTA intent may accompany the input. If one is given, end with a natural, non-salesy CTA line that fits the post and the author's voice — one line, as the final line. If the CTA intent is "Nothing (no CTA)", do not add a CTA.`;

const OUTPUT_RULES = `OUTPUT:
- Return only the LinkedIn post text. No preamble, labels, JSON, or explanation. The first line of your response is the first line of the post.
- Do not append hashtags. Do not use emojis.
- One sentence per line; a blank line between every 2–3 lines. Never more than one consecutive blank line.
- Do not include links unless one is explicitly provided in the input.`;

/**
 * Assemble the system prompt for a recipe. Exported for testing.
 * @param {object} recipe
 * @param {object} profile
 * @param {string} examplesBlock  formatted published-examples block ('' if none)
 */
function buildSystemPrompt(recipe, profile, examplesBlock = '') {
  const authorContext = buildSharedAuthorContext(profile);
  const core = buildAuthenticityCore({
    includeCraftRules: recipe.includeCraftRules,
    allowEnumeration:  recipe.allowEnumeration,
  });

  const sections = [
    BASE_ROLE,
    recipe.structureGuide,
    authorContext,
    examplesBlock ? examplesBlock.trim() : '',
    core,
    LENGTH_GUIDANCE,
    recipe.acceptsCtaIntent ? CTA_HANDLING : '',
    OUTPUT_RULES,
  ].filter(Boolean);

  return sections.join('\n\n');
}

/**
 * Assemble the user prompt. Exported for testing.
 */
function buildUserPrompt(recipe, rawIdea, lengthPreference = 'Medium', ctaIntent = '') {
  const head = recipe.inputLabel ? `${recipe.inputLabel}\n${rawIdea}` : rawIdea;
  const lines = [head, '', `POST LENGTH: ${lengthPreference}`];
  if (recipe.acceptsCtaIntent) {
    const cta = ctaIntent && ctaIntent !== 'Nothing (no CTA)' ? ctaIntent : 'Nothing (no CTA)';
    lines.push(`CTA INTENT: ${cta}`);
  }
  return lines.join('\n');
}

/**
 * Generate a post for the given recipe slug.
 * Returns { post, synthesis } — the same contract every services/*Path.js used.
 *
 * @param {string} slug   post-type slug (trust|story|lessons_learned|bts|contrarian|
 *                        framework|announcement|lead_gen|pis|results)
 * @param {string} rawIdea
 * @param {object} profile
 * @param {{ lengthPreference?: string, ctaIntent?: string }} [opts]
 */
async function generate(slug, rawIdea, profile, { lengthPreference = 'Medium', ctaIntent = '' } = {}) {
  const recipe = getRecipe(slug);
  if (!recipe) throw new Error(`unknown_post_type:${slug}`);

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');
  const client = new Anthropic({ apiKey });

  const examplesBlock = await fetchPublishedExamples(profile.id);
  const systemPrompt  = buildSystemPrompt(recipe, profile, examplesBlock);
  const avoidance     = await buildHookAvoidance(profile.id);
  const userPrompt    = buildUserPrompt(recipe, rawIdea, lengthPreference, ctaIntent)
    + (avoidance ? `\n\n${avoidance}` : '');

  const message = await client.messages.create({
    model:       SONNET_MODEL,
    max_tokens:  recipe.maxTokens || 1500,
    temperature: 0.8,
    system:      [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages:    [{ role: 'user', content: userPrompt }],
  });

  const raw = message.content.find(b => b.type === 'text')?.text?.trim() || '';
  if (!raw) throw new Error(`${slug}_generation_returned_empty`);

  return {
    post: sanitiseAiTells(raw),
    synthesis: {
      length_preference: lengthPreference,
      cta_intent: recipe.acceptsCtaIntent ? (ctaIntent || null) : null,
    },
  };
}

module.exports = { generate, buildSystemPrompt, buildUserPrompt };

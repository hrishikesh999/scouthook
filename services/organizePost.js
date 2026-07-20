'use strict';

/**
 * services/organizePost.js — "editor, not writer" generation (Captain Scout).
 *
 * The founder has just told Captain Scout their story in their OWN words. This
 * does not write a post — it ORGANIZES what they said into a LinkedIn-shaped
 * post using their exact words: hook lifted from their most striking line,
 * body reordered/trimmed for flow, closing question built from their own point.
 *
 * The whole value is fidelity: it should read exactly like the author, because
 * it IS the author's words. So temperature is low, the prompt forbids
 * paraphrasing/embellishing/inventing, and the output still passes the
 * FABRICATED_SPECIFIC gate (nothing is invented, by construction).
 *
 * Same return contract as ideaToPost: { post, synthesis }.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const {
  buildSharedAuthorContext,
  AI_TELLS_PROHIBITION,
  sanitiseAiTells,
} = require('./generationCore');

const SONNET_MODEL = 'claude-sonnet-4-6';

// Loose, per-type shaping — how to ORGANISE the material, not what to write.
const TYPE_SHAPES = {
  story:           'Shape it as a short story: set the scene, the turn, what it meant. Keep it human.',
  lessons_learned: 'Shape it around the lesson they drew — the situation, then the lesson in their words.',
  bts:             'Shape it as behind-the-scenes: the process and decisions, in the order they happened.',
  contrarian:      "Lead with their contrarian point, then their reasoning. Keep the edge they gave it.",
  framework:       'Shape it as their steps/points, in their words, scannable. Do not add steps they didn\'t say.',
  results:         'Lead with the result/number they stated, then how it happened, in their words.',
  trust:           'Shape it to teach the one idea they explained, in their words. No hype.',
  pis:             'Shape it as problem → the real cause they named → the fix they described.',
  lead_gen:        'Keep it value-first; end with the soft next step only if they mentioned one.',
  reach:           'Shape it as a story or observation — whatever fits what they actually said.',
};

const EDITOR_SYSTEM = `You are a LinkedIn post EDITOR, not a writer. The author told you something in their own words. Your job is to ORGANISE it into a scroll-stopping post — never to rewrite it.

HARD RULES (non-negotiable):
- Use the author's EXACT words and phrasing. Preserve their sentences verbatim wherever possible. Do NOT paraphrase, upgrade their vocabulary, or "improve" their voice.
- Never invent facts, numbers, names, outcomes, dates, or details that are not in their words. If a detail isn't there, leave it out.
- HOOK (first line): build it from the author's own most striking sentence or phrase — lift it and tighten it, but keep their words. Never write a hook the author didn't say the substance of.
- Clean up speech only: remove filler ("um", "like", "you know"), false starts, and repetition; fix obvious grammar where it aids clarity. Nothing more.
- Reorder and lightly trim for flow and impact. You may cut, you may not add.
- Format for LinkedIn: one sentence per line, a blank line between beats, easy to scan on mobile.
- CLOSING: end with ONE strong question built from the author's own point or answer — something their audience would actually reply to or argue about. Not "What do you think?".
- No hashtags. No emojis. No added commentary, no tidy "moral of the story" the author didn't say.

Match the length to what they actually gave you — do not pad to hit a word count. If they gave you three sentences, the post is short.

If it reads like a copywriter wrote it, you have failed. It must read like the author — because these are their words.

${AI_TELLS_PROHIBITION}`;

async function organizePost(rawIdea, profile, { postType = 'reach', lengthPreference = null } = {}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');
  const client = new Anthropic({ apiKey });

  // Voice context is for register-matching only; the words come from the brief.
  const authorContext = buildSharedAuthorContext(profile || {}, { includePhraseLibrary: true });
  const shape = TYPE_SHAPES[postType] || TYPE_SHAPES.reach;

  const systemPrompt = `${EDITOR_SYSTEM}\n\nAUTHOR VOICE (match register only — the words below are theirs):\n${authorContext}`;

  const userPrompt = `The author told me this, in their own words (labelled by what each part is):

"""
${rawIdea}
"""

${shape}

Organise it into the post now. Output only the post as plain text — no preamble, labels, or explanation. The first line of your response is the first line of the post.`;

  const message = await client.messages.create({
    model:       SONNET_MODEL,
    max_tokens:  1400,
    temperature: 0.35, // low — fidelity over flourish
    system:      [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages:    [{ role: 'user', content: userPrompt }],
  });

  const raw = message.content.find(b => b.type === 'text')?.text?.trim() || '';
  if (!raw) throw new Error('organize_generation_returned_empty');

  return {
    post: sanitiseAiTells(raw),
    synthesis: { mode: 'organize', post_type: postType, length_preference: lengthPreference || null },
  };
}

module.exports = { organizePost, EDITOR_SYSTEM };

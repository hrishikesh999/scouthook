'use strict';

const { getSetting } = require('../db');
const { fetchPublishedExamples } = require('./ideaPath');

// ---------------------------------------------------------------------------
// Announcement post generation — single Sonnet call.
// Based on Linked Wishes and Appreciation System Prompt v1.
// ---------------------------------------------------------------------------

const V2_PROMPT_CORE = `# ROLE
You are Justin Welsh, world's top LinkedIn Expert writing a LinkedIn post for wishes, gratitude, greetings, or appreciation.

The user will provide a short description of the occasion or message they want to share.
Your job is to turn that into a warm, sincere, LinkedIn-appropriate post.

[WISHES & APPRECIATION MODE (STRICT)]
This engine is for social goodwill only.

- Do NOT teach, explain, or give advice.
- Do NOT tell a personal life story or emotional journey.
- Do NOT include lessons, frameworks, or insights.
- Do NOT include offers, promotions, or calls to action.
- Do NOT sell, pitch, invite, or direct the reader to do anything.
- Focus only on acknowledgement, gratitude, appreciation, or well-wishing.
- The post should feel natural, human, and socially appropriate for LinkedIn.

TONE & STYLE
- Warm, genuine, and professional.
- Simple, conversational language.
- Avoid hype, marketing language, or exaggerated emotion.
- Write as a real person addressing their network.

LENGTH & STRUCTURE
- Default to a short-to-medium LinkedIn post (approximately 60-120 words).
- Use short paragraphs (1-2 lines each).
- Avoid heavy formatting, sections, or bullet lists.
- The entire post should feel effortless to read on mobile.

EMOJI GUIDELINES
- Emojis are allowed and encouraged as warm or celebratory anchors.
- Use 2-4 relevant emojis maximum.
- Emojis should support the sentiment (gratitude, celebration, warmth).
- Never use emojis on every line or mid-sentence.

HASHTAGS
- Include hashtags ONLY if they are naturally relevant to a widely recognized public occasion (e.g. major festivals or global days).
- If included, limit to 1-2 subtle hashtags at the very end of the post.
- Do not force hashtags.

OUTPUT RULES
- Return only the LinkedIn post text.
- Do NOT include labels such as "Output", "Post", or explanations.
- Do NOT include notes, analysis, or system language.`;

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildAuthorContext(profile) {
  const lines = ['## AUTHOR CONTEXT', 'You are writing for a real person. Match their voice and register precisely.', ''];

  // Brand voice
  const brandLines = [];
  if (profile.brand_description)        brandLines.push(`- What they do: ${profile.brand_description}`);
  if (profile.brand_industry)           brandLines.push(`- Industry: ${profile.brand_industry}`);
  const traits = parseJsonArray(profile.brand_personality_traits);
  if (traits.length)                    brandLines.push(`- Personality: ${traits.join(', ')}`);
  if (profile.brand_emotional_tone)     brandLines.push(`- Tone: ${profile.brand_emotional_tone}`);
  if (profile.brand_archetype)          brandLines.push(`- Archetype: ${profile.brand_archetype}`);
  const beliefs = parseJsonArray(profile.brand_core_beliefs);
  if (beliefs.length)                   brandLines.push(`- Core beliefs:\n${beliefs.map(b => `  - ${b}`).join('\n')}`);
  const phrases = parseJsonArray(profile.brand_phrases_to_use);
  if (phrases.length)                   brandLines.push(`- Phrases to weave in: ${phrases.map(p => `"${p}"`).join(', ')}`);
  if (profile.brand_story_origin)       brandLines.push(`- Their story: ${profile.brand_story_origin}`);
  if (profile.elevator_main_result)     brandLines.push(`- What they deliver: ${profile.elevator_main_result}${profile.elevator_mechanism ? ` — how: ${profile.elevator_mechanism}` : ''}`);

  if (brandLines.length) {
    lines.push('BRAND VOICE:', ...brandLines, '');
  }

  // Audience
  const audLines = [];
  if (profile.audience_description)           audLines.push(`- Who they are: ${profile.audience_description}`);
  const goals = parseJsonArray(profile.audience_goals);
  if (goals.length)                            audLines.push(`- What they want:\n${goals.map(g => `  - ${g}`).join('\n')}`);
  const obstacles = parseJsonArray(profile.audience_obstacles);
  if (obstacles.length)                        audLines.push(`- What blocks them:\n${obstacles.map(o => `  - ${o}`).join('\n')}`);
  const mktBeliefs = parseJsonArray(profile.audience_core_beliefs_market);
  if (mktBeliefs.length)                       audLines.push(`- Their market beliefs:\n${mktBeliefs.map(b => `  - ${b}`).join('\n')}`);
  if (profile.audience_buying_stage)           audLines.push(`- Awareness stage: ${profile.audience_buying_stage}`);
  if (profile.audience_market_sophistication)  audLines.push(`- Market sophistication: ${profile.audience_market_sophistication}`);

  if (audLines.length) {
    lines.push('TARGET AUDIENCE:', ...audLines, '');
  }

  // Authority proof
  const authStatements = parseJsonArray(profile.authority_statements).slice(0, 3);
  if (authStatements.length) {
    lines.push('AUTHORITY PROOF (use only when it fits naturally — never force it):',
      ...authStatements.map(s => `- ${s}`), '');
  }

  // Voice DNA
  if (profile.voice_fingerprint) {
    lines.push('VOICE DNA (distilled voice signature — replicate this tone and register exactly):',
      profile.voice_fingerprint, '');
  }

  return lines.join('\n');
}

async function buildAnnouncementSystemPrompt(profile) {
  const publishedExamples = await fetchPublishedExamples(profile.id);
  const authorContext = buildAuthorContext(profile);

  const parts = [V2_PROMPT_CORE];
  if (publishedExamples) parts.push(publishedExamples);
  if (authorContext)     parts.push(authorContext);
  parts.push('Now write the LinkedIn post.');

  return parts.join('\n\n');
}

async function generateAnnouncementPost(rawIdea, profile, { lengthPreference = 'Medium' } = {}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('no_api_key');

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const systemPrompt = await buildAnnouncementSystemPrompt(profile);

  const userPrompt = `Occasion / Message:\n${rawIdea}\n\nPost length: ${lengthPreference}`;

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1000,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userPrompt }],
  });

  const post = message.content.find(b => b.type === 'text')?.text?.trim() || '';
  if (!post) throw new Error('announcement_generation_returned_empty');

  return {
    post,
    synthesis: { length_preference: lengthPreference, cta_intent: null },
  };
}

module.exports = { generateAnnouncementPost };

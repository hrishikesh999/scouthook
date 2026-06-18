'use strict';

const { getSetting } = require('../db');
const { fetchPublishedExamples } = require('./ideaPath');

// ---------------------------------------------------------------------------
// Authority/Expertise post generation — single Sonnet call.
// Based on LinkedIn Authority / Expertise Prompt v2.
// ---------------------------------------------------------------------------

const V2_PROMPT_CORE = `#ROLE
You are "Justin Welsh," a world-class LinkedIn expert who writes high-performing, authority-building posts for founders, creators, educators, and consultants.

Your goal is to help the user clearly explain or clarify one idea they understand well, in a way that builds credibility and trust.
The post should feel insightful, grounded, and confident — without sounding promotional, preachy, or generic.

Write as a knowledgeable peer sharing clarity, not as a marketer or influencer.

## AUTHORITY POST PRINCIPLES
- Focus on clarity over cleverness.
- Teach through explanation, not instruction.
- Avoid hype, exaggeration, or self-praise.
- Let credibility come from insight quality, not claims.
- One core idea per post (especially in Short mode).

CTA HANDLING
The CTA is optional and intent-based.

[CTA INTENT RESOLUTION]
If a CTA intent is provided, infer a natural, LinkedIn-appropriate CTA line based on:
- the selected CTA intent
- the post content
- the brand voice
Keep the CTA short, non-salesy, and place it as the final line.
If CTA intent = "Nothing (no CTA)", do not include a CTA.

LINK HANDLING
- Do not include any links unless explicitly provided in the input.

LENGTH GUIDANCE
Use POST LENGTH as a creative direction, not a hard limit. Let the idea breathe at whatever length it needs to land well.

- Short: aim for a tight, punchy post — one idea, minimal structure, reads in under 30 seconds.
- Medium: room to explain and give context, but stay focused. No padding.
- Long: a fuller treatment — can use structure, examples, or a multi-step breakdown — but every sentence still earns its place.

Do not mention word counts or length guidance in the final post.

[NO COMMENTARY OVERRIDE (STRICT)]
- Do NOT include any introductions, explanations, or commentary before the post.
- Do NOT describe what you did or how the post was created.
- The first line of your response must be the first line of the LinkedIn post itself.

[LINKEDIN FORMATTING (STRICT)]
Apply these formatting rules to the FINAL post text:

- Mobile-first skim: keep paragraphs to 1-2 lines max.
- Use generous line breaks: add a blank line between major beats or sections.
- Avoid walls of text: no paragraph longer than ~3 lines on mobile.
- Use bullets or numbers only when listing items. Use "-" only.
- Use emojis as visual anchors to improve scannability.
- Emojis are encouraged at these positions:
  - Optional hook anchor (top of post)
  - Section transitions (e.g., before an insight or shift)
  - Before a bullet or numbered list
- You may use 2-5 emojis total when they improve impact.
- Never use emojis mid-sentence.
- Avoid decorative or random emojis; each emoji must signal structure or emphasis.
- Replace all em dashes with a space, comma, or normal dash (-).
- Keep the CTA as a standalone final line (or final 2 lines max). No extra text after the CTA.
- Never insert more than one consecutive blank line.
- Do NOT include labels such as "Output:", "Final post:", "Response:", or any JSON/keys.
- Return only the LinkedIn post text.`;

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

async function buildAuthoritySystemPrompt(profile) {
  const publishedExamples = await fetchPublishedExamples(profile.id);
  const authorContext = buildAuthorContext(profile);

  const parts = [V2_PROMPT_CORE];
  if (publishedExamples) parts.push(publishedExamples);
  if (authorContext)     parts.push(authorContext);
  parts.push('Now write the LinkedIn Authority / Expertise post.');

  return parts.join('\n\n');
}

async function generateAuthorityPost(rawIdea, profile, { lengthPreference = 'Medium', ctaIntent = '' } = {}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const systemPrompt = await buildAuthoritySystemPrompt(profile);

  const ctaLine = ctaIntent && ctaIntent !== 'Nothing (no CTA)'
    ? `CTA INTENT: ${ctaIntent}`
    : 'CTA INTENT: Nothing (no CTA)';

  const userPrompt = `WHAT TO TEACH OR CLARIFY:\n${rawIdea}\n\nPOST LENGTH: ${lengthPreference}\n${ctaLine}`;

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1500,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userPrompt }],
  });

  const post = message.content.find(b => b.type === 'text')?.text?.trim() || '';
  if (!post) throw new Error('authority_generation_returned_empty');

  return {
    post,
    synthesis: { length_preference: lengthPreference, cta_intent: ctaIntent || null },
  };
}

module.exports = { generateAuthorityPost };

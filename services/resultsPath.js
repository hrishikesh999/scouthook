'use strict';

const { getSetting } = require('../db');
const { fetchPublishedExamples } = require('./ideaPath');

// ---------------------------------------------------------------------------
// Results / Case Study post generation — single Sonnet call.
// ---------------------------------------------------------------------------

const V2_PROMPT_CORE = `#ROLE
You are "Justin Welsh," a world-class LinkedIn authority builder and proof-based content strategist.
You specialize in transforming real results, milestones, and client outcomes into credibility-building
LinkedIn posts that attract the right audience and make them think "that's possible for me too."

Your job: Use the Author Context and the Result Payload to produce a high-performing
LinkedIn Results / Case Study post.

You MUST:
- Stay fully aligned with the brand's voice, tone, personality, and archetype
- Address the real goals, aspirations, obstacles, and beliefs of the target audience
- Never invent numbers, data, or facts not provided in the input
- Write natively for LinkedIn (mobile-first, skimmable)
- Lead with the result — make the hook specific, concrete, and scroll-stopping
- Keep the tone earned and credible, never boastful or self-congratulatory
- Make the reader think "I want that" or "that could be me"
- Connect the result to a meaningful lesson or belief that resonates with the audience

## RESULTS / CASE STUDY POST STRUCTURE
Follow this arc in every post:

1. Hook — lead with the result: a number, a before/after contrast, or a milestone.
   Specific > generic. One or two short lines.
2. Before — briefly set up where things were. 1–2 lines. Creates contrast and relatability.
3. What Changed — the mechanism, decision, or approach that drove the result (if provided).
   The "how" builds credibility and makes the reader think "I can do that."
   If not provided, skip to step 4.
4. What It Proves — one clear insight, belief shift, or lesson this result demonstrates.
   Specific to the situation, never a generic platitude.
5. Who This Is For — briefly signal who can relate or achieve something similar (if provided).
   Keep it 1 line, natural, not forced. Omit if not provided.
6. CTA — based on CTA INTENT below

## TONE RULES
- Specific > vague
- Credible > hypey
- Earned > boastful
- Relatable > impressive-for-its-own-sake
- Show the mechanism; avoid "I just worked hard"
- Vulnerability around the "before" builds trust — use it

CTA HANDLING
If a CTA intent is provided, infer a natural, LinkedIn-appropriate CTA line based on the
intent, post content, and brand voice. Keep it short, non-salesy, placed as the final line.
If CTA intent = "Nothing (no CTA)", do not include a CTA.

LINK HANDLING
- Do not include any links unless explicitly provided in the input.

LENGTH GUIDANCE
Use POST LENGTH as a creative direction, not a hard limit.
- Short: aim for 8–12 lines — tight hook, brief before, result, one clear lesson
- Medium: 12–18 lines — room for the full arc, no padding
- Long: 18–28 lines — fuller treatment; every sentence earns its place

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
- Emojis are optional — use as structural anchors only (2–4 max), never mid-sentence.
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

  const authStatements = parseJsonArray(profile.authority_statements).slice(0, 3);
  if (authStatements.length) {
    lines.push('AUTHORITY PROOF (use only when it fits naturally — never force it):',
      ...authStatements.map(s => `- ${s}`), '');
  }

  if (profile.voice_fingerprint) {
    lines.push('VOICE DNA (distilled voice signature — replicate this tone and register exactly):',
      profile.voice_fingerprint, '');
  }

  return lines.join('\n');
}

async function buildResultsSystemPrompt(profile) {
  const publishedExamples = await fetchPublishedExamples(profile.id);
  const authorContext = buildAuthorContext(profile);

  const parts = [V2_PROMPT_CORE];
  if (publishedExamples) parts.push(publishedExamples);
  if (authorContext)     parts.push(authorContext);
  parts.push('Now write the LinkedIn Results / Case Study post.');

  return parts.join('\n\n');
}

async function generateResultsPost(rawIdea, profile, { lengthPreference = 'Medium', ctaIntent = '' } = {}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const systemPrompt = await buildResultsSystemPrompt(profile);

  const ctaLine = ctaIntent && ctaIntent !== 'Nothing (no CTA)'
    ? `CTA INTENT: ${ctaIntent}`
    : 'CTA INTENT: Nothing (no CTA)';

  const userPrompt = `${rawIdea}\n\nPOST LENGTH: ${lengthPreference}\n${ctaLine}`;

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1500,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userPrompt }],
  });

  const post = message.content.find(b => b.type === 'text')?.text?.trim() || '';
  if (!post) throw new Error('results_generation_returned_empty');

  return {
    post,
    synthesis: { length_preference: lengthPreference, cta_intent: ctaIntent || null },
  };
}

module.exports = { generateResultsPost };

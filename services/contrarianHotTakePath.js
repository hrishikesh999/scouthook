'use strict';

const { getSetting } = require('../db');
const { fetchPublishedExamples } = require('./ideaPath');

// ---------------------------------------------------------------------------
// Contrarian / Hot Take post generation — single Sonnet call.
// Based on LinkedIn Contrarian / Hot Take Prompt v1.
// ---------------------------------------------------------------------------

const V2_PROMPT_CORE = `#ROLE
You are "Justin Welsh," a world-class LinkedIn thought leadership strategist and direct-response copywriter.
You specialize in creating high-performing Contrarian / Hot Take LinkedIn posts that spark conversation,
shift beliefs, and position the creator as a bold, original thinker.

Your job: Use the Author Context and the Contrarian Payload to produce a
scroll-stopping, insight-rich LinkedIn Hot Take post.

You MUST:
- Stay fully aligned with the brand's personality, voice, tone, and archetype
- Address pains, beliefs, misconceptions, and desires of the target audience
- Never invent facts; avoid hallucinating unsupported claims
- Write natively for LinkedIn (mobile-first, skimmable)
- Start with a bold, perspective-shifting hook
- Deliver a clear, contrarian insight that challenges a common belief
- Maintain professionalism even when sharp or bold
- Provide a crisp, belief-shifting conclusion

## CONTRARIAN POST STRUCTURE
Follow this structure in every post:
1. Hook - A sharp, pattern-breaking line that challenges a mainstream belief.
2. The Common Belief (Set Up) - Explain the incorrect assumption or myth the audience believes.
3. Your POV (Counter-belief) - State your contrarian stance clearly and confidently.
4. Supporting Reason / Insight - Provide logic, observation, experience, or analysis that proves your point. Keep it simple, bold, and grounded.
5. Implication - What this means for the reader. Reframe how they should think or act going forward.
6. Closing Question - End with one powerful, specific, open-ended question that invites the reader to engage. The question must be directly tied to the contrarian belief and feel genuinely curious — not rhetorical. Make it specific enough that readers feel compelled to share their own experience or view. Never use "What do you think?" or any generic variation. One question only.

LINK HANDLING
- Do not include any links unless explicitly provided in the input.

LENGTH GUIDANCE
Use POST LENGTH as a creative direction, not a hard limit. Let the idea breathe at whatever length it needs to land well.

- Short: 6-10 lines — sharp, punchy, one clear belief flip
- Medium: 10-15 lines — room for the full structure, no padding
- Long: 15-25 lines — fuller treatment with supporting insight and implication; every sentence earns its place

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
- Emojis are optional — use as structural anchors only (2-4 max), never mid-sentence.
- Replace all em dashes with a space, comma, or normal dash (-).
- The closing question is the final standalone line. No extra text after it.
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

async function buildContrarianSystemPrompt(profile) {
  const publishedExamples = await fetchPublishedExamples(profile.id);
  const authorContext = buildAuthorContext(profile);

  const parts = [V2_PROMPT_CORE];
  if (publishedExamples) parts.push(publishedExamples);
  if (authorContext)     parts.push(authorContext);
  parts.push('Now write the LinkedIn Contrarian / Hot Take post.');

  return parts.join('\n\n');
}

async function generateContrarianPost(rawIdea, profile, { lengthPreference = 'Medium' } = {}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const systemPrompt = await buildContrarianSystemPrompt(profile);

  const userPrompt = `${rawIdea}\n\nPOST LENGTH: ${lengthPreference}`;

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1500,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userPrompt }],
  });

  const post = message.content.find(b => b.type === 'text')?.text?.trim() || '';
  if (!post) throw new Error('contrarian_generation_returned_empty');

  return {
    post,
    synthesis: { length_preference: lengthPreference },
  };
}

module.exports = { generateContrarianPost };

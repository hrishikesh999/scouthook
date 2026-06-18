'use strict';

const { getSetting } = require('../db');
const { fetchPublishedExamples } = require('./ideaPath');

// ---------------------------------------------------------------------------
// Problem → Insight → Solution post generation — single Sonnet call.
// Based on LinkedIn Problem-Insight-Solution Prompt v1.
// ---------------------------------------------------------------------------

const V2_PROMPT_CORE = `SYSTEM / ROLE
You are "Justin Welsh," a world-class LinkedIn strategist and direct-response copywriter.
You specialize in creating Problem → Insight → Solution (PIS) posts that clearly diagnose a
problem, reveal a deeper hidden truth, and present a simple, credible solution framework.

Your job:
Take the Brand Profile, Persona Profile, and PIS Payload and produce a high-level, insightful,
clarity-building LinkedIn post that showcases expertise and earns trust.

You MUST:
- Stay 100% aligned with the brand's voice, tone, personality, and archetype
- Address the persona's pains, beliefs, blind spots, and desires (if persona is provided)
- Use product_profile ONLY when CTA requires it
- Never hallucinate or fabricate unsupported claims
- Use LinkedIn-native structure (skimmable, 1-2 line paragraphs)
- Provide clarity + perspective + a simple framework
- Deliver a belief shift that positions the creator as an expert
- Respect CTA intent and tone at all times

---

STEP 1 — EXTRACT CONTEXT

From brand_profile:
• Identify voice, tone, archetype, style
• Extract core philosophies, beliefs, expert POV
• Identify the brand's unique differentiation

From persona_profile:
• Identify their problems, blockers, misconceptions
• Target their emotional + practical needs
• Adjust phrasing and angle to match their worldview

---

STEP 2 — APPLY TONE

Tone rules:
- Clear > clever
- Practical > verbose
- Expert > motivational
- Logical > fluffy
- Specific > abstract

Use the insight type to shape your angle:
• root_cause → identify underlying issue
• misconception → correct false assumption
• human_psychology → behavioral cause
• data_pattern → observed pattern
• experience_based → learned in the field
• belief_shift → mental reframing

---

STEP 3 — LINKEDIN FORMATTING RULES

You MUST:
• Start with a clear, problem-led hook
• Use 1-2 line paragraphs
• Make the post highly skimmable
• Respect length_preference:
   - short (8-12 lines)
   - medium (12-18 lines)
   - long (18-25 lines)
• Avoid emojis unless brand explicitly uses them
• Avoid jargon unless brand voice requires it

---

STEP 4 — FOLLOW THE PIS STRUCTURE (EXACT)

1. Hook — The Problem
   A sharp, relatable line naming the real problem the persona faces.

2. Problem Expansion
   Describe why this problem is frustrating or costly.
   Use persona language + brand POV.

3. Insight — The Hidden Cause
   Reveal the deeper truth, misconception, or root cause.
   If provided, use the insight/hidden cause from the input. Otherwise infer it credibly.

4. Solution — Simple Framework
   Generate either:
   - A 3-5 step framework
   - OR a principles list
   - OR a simple model
   It must feel practical and believable.

5. Payoff
   Explain how life/business changes once they apply the solution.

6. CTA
   Follow the CTA intent provided.

---

LENGTH GUIDANCE
Use POST LENGTH as a creative direction, not a hard limit. Let the idea breathe at whatever
length it needs to land well. Do not mention word counts or length guidance in the final post.

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

async function buildPisSystemPrompt(profile) {
  const publishedExamples = await fetchPublishedExamples(profile.id);
  const authorContext = buildAuthorContext(profile);

  const parts = [V2_PROMPT_CORE];
  if (publishedExamples) parts.push(publishedExamples);
  if (authorContext)     parts.push(authorContext);
  parts.push('Now write the LinkedIn Problem → Insight → Solution post.');

  return parts.join('\n\n');
}

async function generatePisPost(rawIdea, profile, { lengthPreference = 'Medium' } = {}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const systemPrompt = await buildPisSystemPrompt(profile);

  const userPrompt = `POST CONTENT:\n${rawIdea}\n\nPOST LENGTH: ${lengthPreference}\nCTA INTENT: Nothing (no CTA)`;

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1500,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userPrompt }],
  });

  const post = message.content.find(b => b.type === 'text')?.text?.trim() || '';
  if (!post) throw new Error('pis_generation_returned_empty');

  return {
    post,
    synthesis: { length_preference: lengthPreference },
  };
}

module.exports = { generatePisPost };

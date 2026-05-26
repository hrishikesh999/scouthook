'use strict';

const { db, getSetting } = require('../db');

async function generateInputExamples(userId, tenantId) {
  const profile = await db
    .prepare('SELECT content_niche, audience_role FROM user_profiles WHERE user_id = ? AND tenant_id = ?')
    .get(userId, tenantId);

  if (!profile?.content_niche) return;

  const Anthropic = require('@anthropic-ai/sdk');
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) return;

  const niche    = profile.content_niche;
  const audience = profile.audience_role || 'professionals';

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 400,
    messages: [{
      role:    'user',
      content: `Generate 4 short, specific LinkedIn post input examples for someone in this niche.

Niche: ${niche}
Audience: ${audience}

Rules:
- Each example is 1-2 sentences, written as a raw idea or story seed the user would type into a text box
- Must be specific (include a number, result, timeframe, or named situation)
- Must have some tension or surprise — not just a fact
- Voice: casual, first-person, like someone thinking out loud
- Do NOT write full posts — write raw material that would be pasted as input

Return ONLY a JSON array of 4 strings. No preamble, no markdown, no explanation.
Example format: ["example 1", "example 2", "example 3", "example 4"]`,
    }],
  });

  const raw = (message.content[0]?.text || '').trim();

  let examples;
  try {
    examples = JSON.parse(raw);
    if (!Array.isArray(examples) || examples.length === 0) return;
    examples = examples.slice(0, 4).filter(e => typeof e === 'string' && e.trim());
  } catch {
    return;
  }

  await db
    .prepare('UPDATE user_profiles SET input_examples = ? WHERE user_id = ? AND tenant_id = ?')
    .run(JSON.stringify(examples), userId, tenantId);
}

/**
 * Derives 2-3 content pillars from the user's niche and onboarding answers.
 * Runs once at onboarding completion. Never throws — errors are logged and swallowed.
 */
async function generateContentPillars(userId, tenantId) {
  const profile = await db
    .prepare('SELECT content_niche, audience_role, onboarding_q1, onboarding_q2 FROM user_profiles WHERE user_id = ? AND tenant_id = ?')
    .get(userId, tenantId);

  if (!profile?.content_niche) return;

  const Anthropic = require('@anthropic-ai/sdk');
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) return;

  const context = [
    `Niche: ${profile.content_niche}`,
    profile.audience_role  && `Audience: ${profile.audience_role}`,
    profile.onboarding_q1  && `Their POV / strong opinion: ${profile.onboarding_q1}`,
    profile.onboarding_q2  && `How they describe their work: ${profile.onboarding_q2}`,
  ].filter(Boolean).join('\n');

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 150,
    messages: [{
      role:    'user',
      content: `Based on this professional's profile, identify 2-3 tight content pillars for their LinkedIn strategy.

${context}

Rules:
- A pillar is a specific, repeatable topic area they can write about consistently (2-5 words)
- More specific than their niche category (e.g. "founder-led sales" not "B2B sales")
- Should reflect both their expertise AND their perspective/POV
- No overlap between pillars

Return ONLY a JSON array of 2-3 strings. Example: ["founder-led sales", "pricing psychology", "sales team leadership"]`,
    }],
  });

  const raw = (message.content[0]?.text || '').trim();

  let pillars;
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    pillars = JSON.parse(match ? match[0] : raw);
    if (!Array.isArray(pillars) || pillars.length === 0) return;
    pillars = pillars.slice(0, 3).filter(p => typeof p === 'string' && p.trim());
    if (pillars.length === 0) return;
  } catch {
    return;
  }

  await db
    .prepare('UPDATE user_profiles SET content_pillars = ? WHERE user_id = ? AND tenant_id = ?')
    .run(JSON.stringify(pillars), userId, tenantId);
}

module.exports = { generateInputExamples, generateContentPillars };

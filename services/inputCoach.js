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

module.exports = { generateInputExamples };

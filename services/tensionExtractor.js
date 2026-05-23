'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `A tension requires two opposing states: expectation vs reality, belief vs experience, before vs after, or problem vs solution.

Output one sentence capturing the contradiction clearly.

Formats by post type:
- reach:   "You expected [X] but [Y] happened instead."
- trust:   "The conventional view is [X]. What you actually know is [Y]."
- convert: "Before: [X]. After: [Y]. The change: [Z]."

If both states present:
  { "tension": "<one clear sentence>", "missing": null }

If one state is missing:
  { "tension": null, "missing": "<what is absent>" }

Return only valid JSON.`;

async function extractTension(postType, answer) {
  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) return { tension: null, missing: null };

    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model:       HAIKU_MODEL,
      max_tokens:  150,
      temperature: 0,
      system:      SYSTEM_PROMPT,
      messages: [{
        role:    'user',
        content: `Post type: ${postType}\n\n${answer}`,
      }],
    });

    const text = response.content?.[0]?.text?.trim() || '';
    const parsed = JSON.parse(text);
    return {
      tension: parsed.tension || null,
      missing: parsed.missing || null,
    };
  } catch {
    return { tension: null, missing: null };
  }
}

module.exports = { extractTension };

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// Handles both legacy plain-string and new JSON-array format for writing_samples.
function parseSamplesText(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(Boolean).join('\n\n---\n\n');
  } catch { /* ignore */ }
  return raw;
}

const PHRASE_EXTRACTION_PROMPT = `Extract distinctive phrases from this writing sample that reveal the author's voice.

Focus on:
- Specific verbs and verb phrases that are non-generic
- Sentence openers that are unusual or characterful
- Ways of expressing contrast, conclusion, or emphasis
- Short, punchy clauses (under 10 words) that could work standalone

For each phrase, score its specificity: 1.0 = maximally distinctive to this author, 0.0 = completely generic.
Exclude anything that could have been written by anyone (e.g. "I think", "for example", "this means").

Return a JSON array:
[{ "phrase": "exact phrase from text", "type": "verb_phrase|opener|contrast|emphasis|other", "specificity_score": 0.0-1.0 }]

Return only valid JSON. No explanation.`;

async function seedPhrasesFromWritingSamples(userId, tenantId, writingSamples) {
  writingSamples = parseSamplesText(writingSamples);
  if (!writingSamples || writingSamples.length < 100) return [];

  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) return [];

    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model:       HAIKU_MODEL,
      max_tokens:  1000,
      temperature: 0,
      system:      PHRASE_EXTRACTION_PROMPT,
      messages: [{
        role:    'user',
        content: writingSamples.slice(0, 3000),
      }],
    });

    const text = response.content?.[0]?.text?.trim() || '';
    const phrases = JSON.parse(text);

    if (!Array.isArray(phrases)) return [];

    return phrases.filter(p =>
      p.phrase && typeof p.phrase === 'string' &&
      typeof p.specificity_score === 'number' &&
      p.specificity_score >= 0.5
    );
  } catch {
    return [];
  }
}

module.exports = { seedPhrasesFromWritingSamples };

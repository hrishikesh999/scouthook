'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');

/**
 * Extract a 4-key voice fingerprint from writing samples.
 * Uses claude-haiku-4-5 — cheap, fast, no complex reasoning needed.
 * Called once on profile save when writing_samples is provided or updated.
 *
 * @param {string} writingSamples — 2-3 example posts from the user
 * @returns {Promise<{opening_style, sentence_structure, credibility_mechanism, signature_moves}|null>}
 *          Returns null if extraction fails — never throws (profile save must not be blocked)
 */
async function extractFingerprint(writingSamples) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) {
    console.error('[voiceFingerprint] anthropic_api_key not set in platform_settings');
    return null;
  }

  const client = new Anthropic({ apiKey });

  const prompt = `Analyse these writing samples and extract a voice fingerprint. Return ONLY valid JSON with exactly these 4 keys:

{
  "opening_style": "one sentence describing how this writer typically opens a post",
  "sentence_structure": "one sentence describing their typical sentence length and structure",
  "credibility_mechanism": "one sentence describing how they establish credibility",
  "signature_moves": ["phrase 1", "phrase 2", "phrase 3"]
}

Writing samples:
---
${writingSamples}
---

Return only the JSON object. No explanation, no markdown fences.`;

  let responseText = '';

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    responseText = message.content[0]?.text?.trim() || '';
    return parseAndValidateFingerprint(responseText);
  } catch (firstErr) {
    if (firstErr instanceof SyntaxError && responseText) {
      // Retry once with explicit instruction
      try {
        const retry = await client.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 600,
          messages: [
            { role: 'user', content: prompt },
            { role: 'assistant', content: responseText },
            { role: 'user', content: 'Return only valid JSON, no other text.' },
          ],
        });
        responseText = retry.content[0]?.text?.trim() || '';
        return parseAndValidateFingerprint(responseText);
      } catch (retryErr) {
        console.error('[voiceFingerprint] Retry failed:', retryErr.message);
        return null;
      }
    }
    console.error('[voiceFingerprint] Extraction failed:', firstErr.message);
    return null;
  }
}

function parseAndValidateFingerprint(text) {
  const parsed = extractJsonFromResponse(text);
  const required = ['opening_style', 'sentence_structure', 'credibility_mechanism', 'signature_moves'];
  for (const key of required) {
    if (!parsed[key]) throw new SyntaxError(`Missing key: ${key}`);
  }
  return parsed;
}

/**
 * Parse JSON from a Claude text response, handling markdown code fences.
 * Reuse this in all services that parse Claude JSON output.
 *
 * @param {string} text
 * @returns {object}
 */
function extractJsonFromResponse(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { extractFingerprint, extractJsonFromResponse };

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const { extractJsonFromResponse } = require('./voiceFingerprint');
const { HOOK_ARCHETYPES, ARCHETYPE_KEYS } = require('./hookArchetypes');

const HAIKU_MODEL = 'claude-haiku-4-5';

const SYSTEM_PROMPT = `You are a LinkedIn content strategist. Your only job is to classify a raw thought into one of eight hook archetypes. You must return only a valid JSON object with two keys: 'archetype' (one of the eight archetype names in uppercase) and 'confidence' (a number between 0 and 1). No other output.`;

function buildArchetypeListForPrompt() {
  return ARCHETYPE_KEYS.map(key => {
    const a = HOOK_ARCHETYPES[key];
    return `- ${key}: ${a.trigger}`;
  }).join('\n');
}

function buildHookInjection(record) {
  return `HOOK ARCHETYPE: ${record.name}
HOOK INSTRUCTION: ${record.structureInstruction}
EXAMPLE OF THIS HOOK STYLE (do not copy — use as structural reference only): "${record.exampleHook}"
IMPORTANT: The hook must reflect the user's voice fingerprint and their specific raw thought — not the example above.`;
}

function insightFallback(reason) {
  if (reason) console.warn('[hookSelector]', reason);
  const a = HOOK_ARCHETYPES.INSIGHT;
  return {
    archetype: 'INSIGHT',
    confidence: 0.5,
    structureInstruction: a.structureInstruction,
    exampleHook: a.exampleHook,
    hookInjection: buildHookInjection(a),
  };
}

/**
 * Classify raw thought into a hook archetype (Haiku). Never throws.
 * @param {string} rawThought
 * @param {object} voiceProfile — full user_profiles row (voice_fingerprint JSON string; reserved for future prompt enrichment)
 * @returns {Promise<{ archetype: string, confidence: number, structureInstruction: string, exampleHook: string, hookInjection: string }>}
 */
async function selectHook(rawThought, voiceProfile) {
  void voiceProfile;

  const thought = (rawThought || '').trim();
  const words = thought.split(/\s+/).filter(Boolean);
  if (words.length < 5) {
    return insightFallback(null);
  }

  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) {
      return insightFallback('anthropic_api_key not configured');
    }

    const client = new Anthropic({ apiKey });

    const archetypeLines = buildArchetypeListForPrompt();
    const userPrompt = `${archetypeLines}

RAW THOUGHT:
${rawThought || ''}

Classify this thought into exactly one archetype. Return only JSON.`;

    const message = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const responseText = message.content[0]?.text?.trim() || '';
    if (!responseText) {
      return insightFallback('Empty classifier response');
    }

    let parsed;
    try {
      parsed = extractJsonFromResponse(responseText);
    } catch (e) {
      return insightFallback(`Classifier JSON parse failed: ${e.message}`);
    }

    let key = typeof parsed.archetype === 'string' ? parsed.archetype.trim().toUpperCase() : '';
    if (!ARCHETYPE_KEYS.includes(key)) {
      return insightFallback(`Invalid archetype from model: ${parsed.archetype}`);
    }

    let confidence = typeof parsed.confidence === 'number' ? parsed.confidence : Number(parsed.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      confidence = 0.5;
    }

    const record = HOOK_ARCHETYPES[key];
    return {
      archetype: key,
      confidence,
      structureInstruction: record.structureInstruction,
      exampleHook: record.exampleHook,
      hookInjection: buildHookInjection(record),
    };
  } catch (err) {
    return insightFallback(`selectHook error: ${err.message}`);
  }
}

module.exports = { selectHook, buildHookInjection };

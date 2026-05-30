'use strict';

/**
 * funnelClassifier.js — Classify content as reach / trust / convert
 * and identify the most suitable hook archetype.
 *
 * Uses Claude Haiku (fast, cheap) — same pattern as hookSelector.js.
 * A single call returns both classifications to avoid two round trips.
 *
 * Funnel types:
 *   reach   — broad stories, observations, hot takes → maximize impressions
 *   trust   — frameworks, methodologies, expertise demonstrations → build authority
 *   convert — offers, client results, case studies, "I help X do Y" → drive inbound
 */

const Anthropic  = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const { extractJsonFromResponse } = require('./voiceFingerprint');
const { ARCHETYPE_KEYS } = require('./hookArchetypes');

const HAIKU_MODEL = 'claude-haiku-4-5';

const FUNNEL_TYPES  = ['reach', 'trust', 'convert'];

const SYSTEM_PROMPT = `You are a LinkedIn content strategist. Classify the given text and return ONLY a valid JSON object with exactly two keys:

1. "funnel_type": one of "reach", "trust", or "convert"
   - reach: broad stories, personal moments, observations, hot takes — optimised for impressions
   - trust: frameworks, methodologies, expertise demonstrations, contrarian positions — builds authority
   - convert: offers, case studies, client results, "I help X do Y" — drives inbound leads

2. "hook_archetype": one of CONFESSION, BEFORE_AFTER, INSIGHT, DIRECT_ADDRESS, NUMBER, MYTH_BUST, CURIOSITY_GAP, REFRAME
   - CONFESSION: personal mistake, failure, or past wrong belief
   - BEFORE_AFTER: transformation contrasting two specific states
   - INSIGHT: states a non-obvious truth as plain confident fact
   - DIRECT_ADDRESS: speaks directly to one specific type of person in a specific situation
   - NUMBER: leads with a striking specific number or statistic
   - MYTH_BUST: names a widely-held wrong belief then immediately reverses it
   - CURIOSITY_GAP: withholds the key detail the reader wants most to create compulsion to read
   - REFRAME: takes something familiar and repositions it from an unexpected angle

Return ONLY the JSON object. No other text.`;

/**
 * Classify a piece of text (post content or seed text) by funnel type and hook archetype.
 * Never throws — returns safe defaults on any failure.
 *
 * @param {string} text  — post content or seed text to classify
 * @returns {Promise<{ funnelType: string, hookArchetype: string, confidence: number }>}
 */
async function classifyContent(text) {
  const safeDefault = { funnelType: 'reach', hookArchetype: 'INSIGHT', confidence: 0.5 };

  const trimmed = (text || '').trim();
  if (trimmed.split(/\s+/).length < 5) return safeDefault;

  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) return safeDefault;

    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model:      HAIKU_MODEL,
      max_tokens: 150,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: `Classify this content:\n\n${trimmed}` }],
    });

    const responseText = message.content[0]?.text?.trim() || '';
    if (!responseText) return safeDefault;

    let parsed;
    try {
      parsed = extractJsonFromResponse(responseText);
    } catch {
      return safeDefault;
    }

    const funnelType = typeof parsed.funnel_type === 'string'
      ? parsed.funnel_type.trim().toLowerCase()
      : '';

    const hookArchetype = typeof parsed.hook_archetype === 'string'
      ? parsed.hook_archetype.trim().toUpperCase()
      : '';

    return {
      funnelType:    FUNNEL_TYPES.includes(funnelType)       ? funnelType    : 'reach',
      hookArchetype: ARCHETYPE_KEYS.includes(hookArchetype)  ? hookArchetype : 'INSIGHT',
      confidence:    0.8,
    };

  } catch (err) {
    console.warn('[funnelClassifier] classification failed (non-fatal):', err.message);
    return safeDefault;
  }
}

module.exports = { classifyContent };

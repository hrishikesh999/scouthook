'use strict';

const { getSetting } = require('../../db');

// Assembles the Brand Voice AI prompt and calls Claude.
// mode='prefill' → Step 1 fields only → returns AI-drafted Step 2 suggestions.
// mode='final'   → all fields → returns full brand_voice_profile JSON, saves cached output.
async function generateBrandVoiceProfile(profile, mode = 'prefill') {
  const Anthropic = require('@anthropic-ai/sdk');
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('no_api_key');

  const client = new Anthropic({ apiKey });

  const step1 = {
    brand_name:               profile.display_name          || '',
    brand_description:        profile.brand_description     || '',
    brand_industry:           profile.brand_industry        || '',
    brand_personality_traits: safeParseJson(profile.brand_personality_traits, []).join(', '),
    elevator_main_result:     profile.elevator_main_result  || '',
    elevator_mechanism:       profile.elevator_mechanism    || '',
  };

  const step2 = mode === 'final' ? {
    brand_story_origin:                    profile.brand_story_origin                    || '',
    brand_emotional_tone:                  profile.brand_emotional_tone                  || '',
    brand_archetype:                       profile.brand_archetype                       || '',
    elevator_main_result:                  profile.elevator_main_result                  || '',
    elevator_mechanism:                    profile.elevator_mechanism                    || '',
    brand_core_beliefs:                    safeParseJson(profile.brand_core_beliefs, []).join('\n'),
    brand_phrases_to_use:                  safeParseJson(profile.brand_phrases_to_use, []).join(', '),
    brand_phrases_to_avoid:                safeParseJson(profile.banned_patterns, []).slice(0, 10).join(', '),
    brand_sample_voice:                    profile.writing_samples ? profile.writing_samples.slice(0, 1000) : '',
  } : null;

  const inputPayload = {
    mode,
    step1,
    ...(step2 ? { step2 } : {}),
  };

  const systemPrompt = getBrandVoiceSystemPrompt();

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1500,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: JSON.stringify(inputPayload) }],
  });

  const responseText = (message.content[0]?.text || '').trim();
  let parsed;
  try {
    const match = responseText.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : responseText);
  } catch {
    throw new Error('Failed to parse Brand Voice AI response as JSON');
  }

  if (mode === 'final') {
    return {
      brand_voice_profile:      parsed.brand_voice_profile || null,
      brand_voice_profile_json: JSON.stringify(parsed),
      suggestions:              extractSuggestions(parsed),
    };
  }

  // prefill — return drafts for Step 2 fields
  return {
    prefill: {
      brand_emotional_tone:  parsed.brand_voice_profile?.brand_emotional_tone  || '',
      brand_archetype:       parsed.brand_voice_profile?.brand_archetype       || '',
      elevator_main_result:  parsed.brand_voice_profile?.elevator_main_result  || '',
      elevator_mechanism:    parsed.brand_voice_profile?.elevator_mechanism    || '',
      brand_core_beliefs:    parsed.brand_voice_profile?.brand_core_beliefs    || [],
      brand_phrases_to_use:  parsed.brand_voice_profile?.brand_phrases_to_use  || [],
      brand_story_origin:    parsed.brand_voice_profile?.brand_story_origin    || '',
      processing_notes:      parsed.meta?.processing_notes || '',
    },
  };
}

function extractSuggestions(parsed) {
  const bvp = parsed.brand_voice_profile || {};
  return {
    brand_emotional_tone: bvp.brand_emotional_tone || '',
    brand_archetype:      bvp.brand_archetype      || '',
    elevator_main_result: bvp.elevator_main_result || '',
    elevator_mechanism:   bvp.elevator_mechanism   || '',
    brand_core_beliefs:   Array.isArray(bvp.brand_core_beliefs)
      ? JSON.stringify(bvp.brand_core_beliefs) : '',
    brand_phrases_to_use: Array.isArray(bvp.brand_phrases_to_use)
      ? JSON.stringify(bvp.brand_phrases_to_use) : '',
    brand_story_origin:   bvp.brand_story_origin   || '',
  };
}

function safeParseJson(val, fallback) {
  try { return val ? JSON.parse(val) : fallback; } catch { return fallback; }
}

function getBrandVoiceSystemPrompt() {
  return `## CRITICAL OUTPUT REQUIREMENT
Return EXACTLY ONE valid JSON object matching the schema below.
- NO markdown code blocks, NO preamble, NO text outside the JSON
- Start immediately with {, end with }
- Use "" for missing strings, [] for missing arrays
- Never omit required schema keys

## SYSTEM ROLE
You are an expert brand strategist and conversion copywriter. Given inputs about a brand, draft the brand voice profile fields that a content creator will review and edit before saving.

## FIELD GUIDE
- brand_name — The brand's name for recognition.
- brand_description — One sentence: what the business does and who it serves.
- brand_industry — Industry/category.
- brand_personality_traits — Comma-separated traits that define writing style (e.g. Bold, Empathetic).
- brand_emotional_tone — Global mood filter for all copy.
- brand_archetype — Primary Jungian archetype (e.g. Sage, Hero, Creator).
- elevator_main_result — The #1 transformation/promise the brand delivers. One sentence.
- elevator_mechanism — The proprietary process/method that enables the result. One sentence.
- brand_core_beliefs — Contrarian takes and market beliefs. Array of short strings.
- brand_phrases_to_use — Signature phrases to sprinkle into content. Array of short strings.
- brand_story_origin — Brief origin story: why the brand was founded, the pivotal moment. 2–4 sentences.
- overview — A fluent 2–3 sentence brand summary combining the main result and mechanism.

## PROCESSING RULES

### Mode: prefill
Parse Step 1 inputs and draft Step 2 suggestions. If a mandatory field (brand_name, brand_description, brand_personality_traits, brand_industry) is missing, proceed with what's available. Include a brief processing_notes string summarising detected tone/style patterns (e.g. "Confident expert tone, recurring themes: clarity, frameworks, ROI").

### Mode: final
Merge all user-provided inputs. Normalise tone and punctuation. Remove any placeholder text.

## OUTPUT SCHEMA
{
  "meta": {
    "processing_notes": ""
  },
  "brand_voice_profile": {
    "brand_name": "",
    "overview": "",
    "brand_description": "",
    "brand_industry": "",
    "brand_personality_traits": "",
    "brand_story_origin": "",
    "brand_emotional_tone": "",
    "brand_archetype": "",
    "elevator_main_result": "",
    "elevator_mechanism": "",
    "brand_core_beliefs": [],
    "brand_phrases_to_use": []
  }
}`;
}

module.exports = { generateBrandVoiceProfile };

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
    max_tokens: 2000,
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
      brand_voice_profile:        parsed.brand_voice_profile       || null,
      brand_conversion_intelligence: parsed.brand_conversion_intelligence || null,
      brand_proof_to_claim_mapping:  parsed.brand_proof_to_claim_mapping  || null,
      brand_voice_profile_json:   JSON.stringify(parsed),
      // Suggested field values the UI can pre-fill
      suggestions: extractSuggestions(parsed),
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
  return `## CRITICAL OUTPUT REQUIREMENT:
You MUST return EXACTLY ONE valid JSON object matching the schema at the end of this prompt.
STRICT RULES:
1. NO markdown code blocks (no \`\`\`json or \`\`\`)
2. NO preamble, explanation, or text before the JSON
3. NO text after the JSON
4. Start your response immediately with {
5. End with }
6. All text content must be within JSON string values
7. Validate JSON syntax before responding
If you cannot complete a field, use "" for strings or [] for arrays. Never omit required schema keys.
RETURN ONLY RAW JSON - NO FORMATTING WHATSOEVER

## SYSTEM ROLE
You are an elite A-list direct response copywriter trained in behavioral psychology, persuasion science, and conversion copywriting. You will receive detailed inputs about a Brand. Your task is to interpret these inputs with maximum psychological depth and translate them into an actionable brand profile that can drive high-converting copy across all formats and industries.

## FIELD_CONTEXT_MAP

### [Priority: HIGH | MANDATORY]
- brand_name — Exact string for recognition; attach to strongest proof; use in headlines/CTAs and proof mapping.
- brand_description — A brief description of what the business does and who it serves.
- elevator_main_result — Brand's #1 promise; lead overview, benefit_primary, Problem/Solution-Aware hooks; pair with proof.
- elevator_mechanism — Proprietary "how"; use in mechanism-led headlines; tie to result; handle competitive objections.
- brand_personality_traits — Convert to style cues (Bold→power verbs; Empathetic→sensory language); gate tone everywhere.
- brand_emotional_tone — Global mood filter (Calm→reassurance hooks; Energetic→challenge hooks).
- brand_industry — Sets vocabulary, tone, proof benchmarking; contextualize overview.

### [Priority: MEDIUM]
- brand_archetype — Map to narrative arc (Hero→struggle→victory; Sage→teaching); influence vocab/structure.
- brand_core_beliefs — Myth-busting/problem-aware hooks; contrarian authority lines; link to mechanism as "fix".
- brand_phrases_to_use — Sprinkle into benefits, proof, CTAs.
- brand_story_origin — Humanize; origin→mission; echo main_result.

## PROCESSING RULES

### Mode: prefill
Parse Step 1 inputs. Mandatory fields check (MUST be present): brand_name, brand_description, brand_personality_traits, brand_industry.
If any mandatory field is missing/empty: set that field to "MISSING_FIELD" and proceed; mark dependent content with [Inferred]; never fabricate proof.
Extract tone markers, recurring keywords, archetype indicators.
Auto-draft Step 2 suggestions. Assign confidence_score (0–1) to each. confidence < 0.6 → mark as suggestion-only.
Include processing_notes with a brief summary of detected patterns (e.g., "Detected a confident expert tone with recurring keywords: clarity, ROI, framework").

### Mode: final
Merge user-approved edits with prefill output. Normalize tone, punctuation, locale-specific spellings.
Remove placeholder text or unverified claims. Output finalized Brand Profile JSON.

## TONE GUARDRAILS
Compute and apply:
- sentence_length_band: short | medium | long
- power_verb_frequency: low | medium | high
- sensory_density: low | medium | high
- formality_level: casual | neutral | formal
If any tone inputs are "MISSING_FIELD", default to: medium / medium / low / neutral.

## PERSUASION MAPPING
Link each claim/benefit → proof → emotional & logical drivers.
Combine elevator_main_result + elevator_mechanism into a fluent, high-impact overview.

## CREATIVE EXPANSION
Produce angle_matrix, narrative_seeds, and channel_micro_hooks (≥3 stages × 4 channels).
Include ≥2 contrarian hooks from brand_core_beliefs if present, ≥1 proof-led hook.

## QUALITY GATES
angle_matrix ≥ 5, narrative_seeds ≥ 5, channel_micro_hooks ≥ 12, objection_handlers ≥ 3,
positioning_statements ≥ 2, elevator_pitch_variants ≥ 2 (must include a short variant ≤15w).

## OUTPUT SCHEMA
{
  "meta": {
    "model_version": "claude-sonnet-4-6",
    "brand_profile_id": "",
    "created_at": "",
    "locale": "en-US",
    "input_hash": "",
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
    "brand_phrases_to_use": [],
    "brand_sample_voice": []
  },
  "brand_conversion_intelligence": {
    "persuasion_emotional_drivers": [],
    "persuasion_logical_drivers": [],
    "persuasion_cognitive_biases": [],
    "storytelling_arcs": [],
    "benefit_primary": "",
    "benefit_secondary": [],
    "angle_matrix": [],
    "narrative_seeds": [],
    "objection_handlers": [],
    "tone_guidelines": "",
    "tone_guardrails": {
      "sentence_length_band": "",
      "power_verb_frequency": "",
      "sensory_density": "",
      "formality_level": ""
    },
    "channel_micro_hooks": []
  },
  "brand_proof_to_claim_mapping": [
    {
      "claim": "",
      "supported_by_proof": "",
      "addresses_objection": ""
    }
  ]
}`;
}

module.exports = { generateBrandVoiceProfile };

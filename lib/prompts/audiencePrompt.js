'use strict';

const { getSetting } = require('../../db');

// Assembles the Audience AI prompt and calls Claude.
// mode='prefill' → audience_description only → returns AI-drafted Step 2 suggestions.
// mode='final'   → all fields + brand context → returns full audience profile JSON.
async function generateAudienceProfile(profile, mode = 'prefill') {
  const Anthropic = require('@anthropic-ai/sdk');
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('no_api_key');

  const client = new Anthropic({ apiKey });

  const step1 = {
    audience_identifier:  extractAudienceIdentifier(profile),
    audience_description: profile.audience_description || '',
  };

  const step2 = mode === 'final' ? {
    audience_goals:               safeParseJson(profile.audience_goals, []).join('\n'),
    audience_obstacles:           safeParseJson(profile.audience_obstacles, []).join('\n'),
    audience_core_beliefs_market: safeParseJson(profile.audience_core_beliefs_market, []).join('\n'),
    audience_buying_stage:        profile.audience_buying_stage        || '',
    audience_market_sophistication: profile.audience_market_sophistication || '',
  } : null;

  // Brand context injected in final mode to align persona with brand voice
  const brandContext = mode === 'final' && profile.brand_voice_profile_json
    ? profile.brand_voice_profile_json.slice(0, 2000)
    : null;

  const inputPayload = {
    brand_profile_context: brandContext || '',
    customer_persona_input: {
      mode,
      step1,
      ...(step2 ? { step2 } : {}),
    },
  };

  const systemPrompt = getAudienceSystemPrompt();

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
    throw new Error('Failed to parse Audience AI response as JSON');
  }

  if (mode === 'final') {
    return {
      customer_persona:       parsed.customer_persona      || null,
      conversion_intelligence: parsed.conversion_intelligence || null,
      brand_alignment_notes:  parsed.brand_alignment_notes || null,
      audience_profile_json:  JSON.stringify(parsed),
      suggestions: extractSuggestions(parsed),
    };
  }

  // prefill — return drafts for Step 2 fields
  const cp = parsed.customer_persona || {};
  return {
    prefill: {
      audience_goals:               Array.isArray(cp.persona_goals)               ? cp.persona_goals               : [],
      audience_obstacles:           Array.isArray(cp.persona_obstacles)           ? cp.persona_obstacles           : [],
      audience_core_beliefs_market: Array.isArray(cp.persona_core_beliefs_market) ? cp.persona_core_beliefs_market : [],
      audience_buying_stage:        cp.persona_buying_stage        || '',
      audience_market_sophistication: cp.persona_market_sophistication || '',
    },
  };
}

function extractAudienceIdentifier(profile) {
  // Derive a short identifier from the description if available
  if (profile.audience_description) {
    return profile.audience_description.split(/[.,\n]/)[0].trim().slice(0, 80);
  }
  return '';
}

function extractSuggestions(parsed) {
  const cp = parsed.customer_persona || {};
  return {
    audience_goals: Array.isArray(cp.persona_goals)
      ? JSON.stringify(cp.persona_goals) : '',
    audience_obstacles: Array.isArray(cp.persona_obstacles)
      ? JSON.stringify(cp.persona_obstacles) : '',
    audience_core_beliefs_market: Array.isArray(cp.persona_core_beliefs_market)
      ? JSON.stringify(cp.persona_core_beliefs_market) : '',
    audience_buying_stage:          cp.persona_buying_stage          || '',
    audience_market_sophistication: cp.persona_market_sophistication || '',
  };
}

function safeParseJson(val, fallback) {
  try { return val ? JSON.parse(val) : fallback; } catch { return fallback; }
}

function getAudienceSystemPrompt() {
  return `## SYSTEM ROLE
You are an elite A-list direct-response copywriter trained in behavioral psychology, persuasion science, and conversion copywriting.

You will receive inputs about an Audience (target customer/reader) and optionally a Brand Voice Profile. Interpret both with maximum psychological depth and translate them into an actionable audience profile that drives high-converting LinkedIn content.

mode: "prefill" → after Step 1, return drafts only for Step 2 fields (no conversion_intelligence).
mode: "final"   → after Step 2, return the full Audience Profile + Conversion Intelligence.

## FIELD CONTEXT MAP

Step 1 (Quick Capture — Mandatory):
- audience_identifier → quick overview of the audience (1–3 words)
- audience_description → overview in natural language (who they are + context)

Step 2 (Enrichment):
- audience_goals → primary + secondary goals (array)
- audience_obstacles → specific internal/external blockers
- audience_core_beliefs_market → what they believe about the industry
- audience_buying_stage → Unaware | Problem Aware | Solution Aware | Product Aware | Most Aware
- audience_market_sophistication → Stage 1 | Stage 2 | Stage 3 | Stage 4 | Stage 5

## HALLUCINATION PREVENTION
Never create specific names, brands, statistics, or factual claims unless stated in input. If vague, summarize broadly. Do not fabricate credibility fields.

## BRAND → AUDIENCE ALIGNMENT
- brand_personality → shapes emotional vocabulary & empathy tone
- brand_archetype → sets narrative lens
- brand_core_promise → frames audience's perceived solution
- brand_values → determines value alignment

Fallback if brand context missing: tone = Neutral Expert, archetype = Sage.

## CRITICAL OUTPUT INSTRUCTION
Return ONLY the raw JSON object. No markdown code fences. No explanatory text. Start with {. End with }.

{
  "meta": {
    "cp_spec_version": "5.0",
    "mode": "",
    "created_at": "",
    "locale": "en-US",
    "input_hash": ""
  },
  "brand_alignment_notes": {
    "emotional_alignment": "",
    "value_alignment": "",
    "archetype_interplay": "",
    "tone_calibration": ""
  },
  "customer_persona": {
    "persona_identifier": "",
    "persona_description": "",
    "persona_goals": [],
    "persona_challenges": [],
    "persona_core_values": [],
    "persona_obstacles": [],
    "persona_core_beliefs_market": [],
    "persona_buying_stage": "",
    "persona_market_sophistication": ""
  },
  "inference_flags": {
    "persona_goals": false,
    "persona_challenges": false,
    "persona_obstacles": false,
    "persona_core_beliefs_market": false,
    "persona_buying_stage": false,
    "persona_market_sophistication": false
  },
  "conversion_intelligence": {
    "hooks": [],
    "narrative_seeds": [],
    "objection_handlers": [],
    "positioning_statements": [],
    "elevator_pitch_variants": [],
    "emotional_drivers": [],
    "cognitive_biases_applied": [],
    "future_pacing": [],
    "risk_reversal_line": "",
    "channel_optimization_notes": {
      "linkedin": ""
    },
    "essentials": {
      "headline": "",
      "hook": "",
      "cta": ""
    }
  }
}`;
}

module.exports = { generateAudienceProfile };

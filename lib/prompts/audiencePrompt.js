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
    persona_identifier:  extractAudienceIdentifier(profile),
    persona_description: profile.audience_description || '',
  };

  const step2 = mode === 'final' ? {
    persona_goals:                 safeParseJson(profile.audience_goals, []).join('\n'),
    persona_obstacles:             safeParseJson(profile.audience_obstacles, []).join('\n'),
    persona_core_beliefs_market:   safeParseJson(profile.audience_core_beliefs_market, []).join('\n'),
    persona_buying_stage:          profile.audience_buying_stage          || '',
    persona_market_sophistication: profile.audience_market_sophistication || '',
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
You are an expert audience researcher. You receive inputs about a customer persona and return a structured persona profile.

mode: "prefill" → after Step 1, return drafts only to prefill Step 2 fields.
mode: "final"   → after Step 2, return the completed customer_persona with all fields merged.

## FIELD CONTEXT MAP

### Step 1 (Quick Capture — Mandatory)
- persona_identifier → a quick overview of the audience (1–3 words)
- persona_description → overview in natural language (who they are + context)

### Step 2 (Enrichment — AI Prefill + User Edits)
- persona_goals → primary + 2–3 secondary goals (array; first = primary)
- persona_obstacles → specific internal/external factors blocking goal achievement
- persona_core_beliefs_market → what they believe to be true (or false) about the industry/category
- persona_buying_stage → Unaware | Problem Aware | Solution Aware | Product Aware | Most Aware
- persona_market_sophistication → Stage 1 | Stage 2 | Stage 3 | Stage 4 | Stage 5

## PROCESSING RULES

### Mode: prefill
Use Step 1 inputs only.
Generate draft suggestions for: persona_goals (primary + 2–3 secondaries), persona_obstacles, persona_core_beliefs_market, persona_buying_stage (inferred), persona_market_sophistication (inferred).
All other fields → "MISSING_FIELD".

### Mode: final
Merge Step 1 + Step 2 (user edits override AI drafts).
Return the completed customer_persona with all fields merged.
If persona_buying_stage or persona_market_sophistication absent → leave "" (empty).

## MANDATORY FIELDS CHECK
Required: persona_identifier, persona_description. If missing → "MISSING_FIELD".

## HALLUCINATION PREVENTION
Never create specific names, brands, statistics, or factual claims unless explicitly stated in input. If vague, summarize broadly without assuming specifics. Do not fabricate.

## AWARENESS REFERENCE TABLES

### persona_buying_stage
| Value | Meaning |
|---|---|
| Unaware | Doesn't recognize problem |
| Problem Aware | Feels pain but no solution |
| Solution Aware | Knows solutions exist, not yours |
| Product Aware | Knows your offer |
| Most Aware | Ready to buy |

### persona_market_sophistication
| Value | Meaning |
|---|---|
| Stage 1 | New market, no competitors |
| Stage 2 | Few competitors, simple claims work |
| Stage 3 | Many competitors making the same claim |
| Stage 4 | Market has heard all claims, needs differentiation |
| Stage 5 | Oversaturated, cynical market |

## CRITICAL OUTPUT INSTRUCTION
Return ONLY the raw JSON object. Do NOT wrap in markdown code fences. Do NOT include any text before { or after }. Valid parseable JSON only.

{
  "customer_persona": {
    "persona_identifier": "",
    "persona_description": "",
    "persona_goals": [],
    "persona_obstacles": [],
    "persona_core_beliefs_market": [],
    "persona_buying_stage": "",
    "persona_market_sophistication": ""
  }
}`;
}

module.exports = { generateAudienceProfile };

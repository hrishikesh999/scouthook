'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const { extractJsonFromResponse } = require('./voiceFingerprint');
const { buildVoiceDNABlock } = require('./voiceExtraction');
const { sanitiseAiTells } = require('./postSanitiser');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const SONNET_MODEL = 'claude-sonnet-4-6';

const VALID_TEMPLATES = ['research_drop', 'system_giveaway', 'transformation', 'breaking_news'];

/**
 * Use Haiku to auto-select the best lead magnet template based on resource + proof.
 * Returns one of: research_drop | system_giveaway | transformation | breaking_news
 * Falls back to 'system_giveaway' on any error.
 */
async function selectTemplate(inputs, client) {
  try {
    const message = await client.messages.create({
      model:      HAIKU_MODEL,
      max_tokens: 80,
      system:     'Return only valid JSON, nothing else.',
      messages: [{
        role:    'user',
        content: `Given this resource and proof, pick the best template:
- research_drop: user analyzed/studied/collected data
- system_giveaway: user has a proven system with client results
- transformation: user has a before/after story with real numbers
- breaking_news: tied to a new tool, update, or timely angle

Resource: ${inputs.resourceName}
Proof: ${inputs.proof}

Return only JSON: { "template": "research_drop|system_giveaway|transformation|breaking_news" }`,
      }],
    });
    const text = message.content[0]?.text?.trim() || '';
    const parsed = extractJsonFromResponse(text);
    const t = parsed?.template;
    return VALID_TEMPLATES.includes(t) ? t : 'system_giveaway';
  } catch {
    return 'system_giveaway';
  }
}

function buildLeadMagnetSystemPrompt(userProfile, template) {
  const voiceDNA = buildVoiceDNABlock(userProfile);
  return `You are writing a LinkedIn lead magnet post for ${userProfile.audience_role || 'professionals'}.

${voiceDNA}

POST TYPE: LEAD MAGNET
A lead magnet post offers a free resource in exchange for a comment. Every commenter receives
the resource via DM — which means every comment is a conversation started.

STRUCTURE (follow in order — do not skip any element):
1. HOOK (lines 1–3): Use the ${template} template pattern. Must include the user's real proof number.
   The hook determines whether this post goes viral. It must stop the scroll in the first 6 words.
2. PROBLEM: Create contrast between the current pain and what this resource solves. Be specific.
3. PERSPECTIVE SHIFT: One or two sentences. The "aha" that makes the solution feel inevitable.
4. DELIVERABLES: List exactly what's inside using → bullets. Each line must be outcome-focused.
   Use the user's deliverables verbatim — make each one more specific and outcome-driven, but
   do NOT invent new items or change what they describe.
5. SOCIAL PROOF: Frame the user's proof naturally — one line, before the CTA.
6. CTA: Always exactly this format:
   "Want it?
   1. Connect with me (so I can DM)
   2. Comment [KEYWORD]
   I'll send it straight to your DMs."
   Replace [KEYWORD] with the user's exact keyword. Do not modify the CTA structure.
7. P.S. (optional): Add only if a repost incentive or urgency line would strengthen the post.

ABSOLUTE RULES:
- NEVER invent deliverables, numbers, metrics, or results. Use only what the user provided.
- If the proof field has a specific number, that number must appear in the hook or social proof.
- The keyword in the CTA must be exactly the word the user supplied.
- No em dashes. No tricolons. No hedging ("I think", "maybe").
- One sentence per line. Visual breathing room between blocks.`;
}

function buildLeadMagnetUserPrompt(inputs, userProfile) {
  const proofInstruction = inputs.proofMode === 'description'
    ? 'PROOF (description — do NOT require a number in the hook; describe who it worked for instead):'
    : 'PROOF (real number — must appear in hook or social proof):';

  return `RESOURCE: ${inputs.resourceName}

DELIVERABLES (make each outcome-focused — do not add new items):
${inputs.deliverables.map(d => `- ${d}`).join('\n')}

${proofInstruction}
${inputs.proof}

COMMENT KEYWORD: ${inputs.keyword}

TEMPLATE: ${inputs.template}

AUTHOR NICHE: ${userProfile.content_niche || 'not specified'}
AUTHOR AUDIENCE: ${userProfile.audience_role || 'professionals'}
BUSINESS POSITIONING: ${userProfile.business_positioning || 'not specified'}

Return ONLY valid JSON:
{
  "post": "full text of the lead magnet post",
  "hook_used": "one line describing the hook pattern used",
  "keyword_confirmed": "${inputs.keyword}"
}

No markdown fences. No explanation. Only the JSON.`;
}

/**
 * Generate a lead magnet post.
 *
 * @param {object} inputs
 * @param {string}   inputs.resourceName
 * @param {string[]} inputs.deliverables
 * @param {string}   inputs.proof
 * @param {string}   inputs.keyword
 * @param {string}   [inputs.proofMode]  'metric' | 'description'
 * @param {string}   [inputs.template]   pre-selected template (skips Haiku auto-select)
 * @param {object} userProfile
 * @returns {Promise<{ post: string, template: string, hookUsed: string, keywordConfirmed: string }>}
 */
async function generateLeadMagnetPost(inputs, userProfile) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');
  const client = new Anthropic({ apiKey });

  // Use user-supplied template if provided; otherwise auto-select via Haiku
  const template = inputs.template && VALID_TEMPLATES.includes(inputs.template)
    ? inputs.template
    : await selectTemplate(inputs, client);

  const inputsWithTemplate = { ...inputs, template };

  const systemPrompt = buildLeadMagnetSystemPrompt(userProfile, template);
  const userPrompt   = buildLeadMagnetUserPrompt(inputsWithTemplate, userProfile);

  let responseText = '';

  try {
    const message = await client.messages.create({
      model:       SONNET_MODEL,
      max_tokens:  2000,
      temperature: 0.3,
      system:      systemPrompt,
      messages:    [{ role: 'user', content: userPrompt }],
    });

    responseText = message.content[0]?.text?.trim() || '';
    const parsed = extractJsonFromResponse(responseText);

    if (!parsed?.post || typeof parsed.post !== 'string') {
      throw new SyntaxError('Lead magnet response missing post field');
    }

    return {
      post:             sanitiseAiTells(parsed.post.trim()),
      template,
      hookUsed:         parsed.hook_used || template,
      keywordConfirmed: parsed.keyword_confirmed || inputs.keyword,
    };
  } catch (firstErr) {
    if (firstErr instanceof SyntaxError && responseText) {
      const retry = await client.messages.create({
        model:       SONNET_MODEL,
        max_tokens:  2000,
        temperature: 0.3,
        system:      systemPrompt,
        messages: [
          { role: 'user',      content: userPrompt },
          { role: 'assistant', content: responseText },
          { role: 'user',      content: 'Return only valid JSON, no other text.' },
        ],
      });
      responseText = retry.content[0]?.text?.trim() || '';
      const parsed = extractJsonFromResponse(responseText);
      if (!parsed?.post) throw new Error('Lead magnet generation failed after retry');
      return {
        post:             sanitiseAiTells(parsed.post.trim()),
        template,
        hookUsed:         parsed.hook_used || template,
        keywordConfirmed: parsed.keyword_confirmed || inputs.keyword,
      };
    }
    throw firstErr;
  }
}

module.exports = { generateLeadMagnetPost, selectTemplate };

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const { extractJsonFromResponse } = require('./voiceFingerprint');
const { buildVoiceDNABlock } = require('./voiceExtraction');
const { selectHook, buildHookInjection } = require('./hookSelector');
const { HOOK_ARCHETYPES, ARCHETYPE_KEYS } = require('./hookArchetypes');
const { AI_TELLS_PROHIBITION, sanitiseAiTells } = require('./postSanitiser');
const { LINKEDIN_RULES } = require('../modules/formatIntelligence/rules');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const ARCHETYPE_POST_TYPE_PREFERENCES = {
  reach:   ['BEFORE_AFTER', 'CONFESSION', 'PATTERN_INTERRUPT'],
  trust:   ['INSIGHT', 'CONTRARIAN', 'DIRECT_ADDRESS'],
  convert: ['NUMBER', 'STAKES', 'BEFORE_AFTER'],
};

const BLUEPRINT_SYSTEM_PROMPT = `You are a LinkedIn content strategist. Analyze the raw idea and return a structural blueprint for a single LinkedIn post.

Return only valid JSON — no explanation, no markdown:
{
  "archetype": "<one of: INSIGHT|CONTRARIAN|BEFORE_AFTER|CONFESSION|NUMBER|STAKES|PATTERN_INTERRUPT|DIRECT_ADDRESS>",
  "confidence": <number 0-1>,
  "tension": "<one sentence: the core contradiction — expectation vs reality, before vs after, belief vs evidence>",
  "arc": "<one sentence: the sequence of moves — what the reader learns and in what order>",
  "hook_draft": "<the first line, under 12 words, applying the archetype to this specific idea>"
}`;

function getLengthGuidance(funnelType) {
  const targets = LINKEDIN_RULES.postLengthTargets;
  return (targets[funnelType] || targets.default).guidance;
}

// Archetype-specific length guidance — used when the archetype is known at build time
const ARCHETYPE_LENGTH_NOTES = {
  BEFORE_AFTER:      'TARGET LENGTH: 400–600 words. This archetype requires a real before scene, a clear turning point, and a developed after. Compress either end and the transformation loses impact. Do not truncate.',
  CONFESSION:        'TARGET LENGTH: 380–560 words. This archetype lives on narrative texture — the emotional arc needs room to breathe. A compressed confession feels hollow.',
  NUMBER:            'TARGET LENGTH: 320–480 words. Each item must be a developed point with a sentence of context, not a bare one-liner. Earn the list.',
  STAKES:            'TARGET LENGTH: 350–500 words. The consequence chain must be traced clearly — what was at risk, what happened, what it cost or delivered.',
  CONTRARIAN:        'TARGET LENGTH: 300–450 words. The argument needs both the claim and the evidence or counter-evidence. One line of proof is not enough.',
  INSIGHT:           'TARGET LENGTH: 280–420 words. Develop the idea fully — state it, show the reasoning, land the implication. Do not state and immediately close.',
  PATTERN_INTERRUPT: 'TARGET LENGTH: 250–400 words. The hook does the heavy lifting; the body earns it. Develop each move without padding.',
  DIRECT_ADDRESS:    'TARGET LENGTH: 280–420 words. Focused and reader-centric. Each sentence must serve the reader, not the author.',
};

function buildPostTypeBlock(postType, archetype = null) {
  const lengthLine = archetype && ARCHETYPE_LENGTH_NOTES[archetype]
    ? ARCHETYPE_LENGTH_NOTES[archetype]
    : null;

  const blocks = {
    reach: `POST GOAL: REACH
This post must attract new readers outside the author's existing audience.
Body structure: Hook → tension or contradiction → resolution → open question
Hook preference (in order): BEFORE_AFTER, CONFESSION, PATTERN_INTERRUPT
Closing: An open question or binary choice. No selling. No DM asks.
${lengthLine || 'TARGET LENGTH: 250–500 words depending on the archetype. Story arcs (BEFORE_AFTER, CONFESSION) need 400+ words to land the transformation. Insight and pattern-interrupt hooks can be tighter. Do not truncate the arc to stay short.'}`,
    trust: `POST GOAL: TRUST
This post must deepen credibility with readers who already follow the author.
Body structure: State a belief → provide evidence or reasoning → land the implication
Hook preference (in order): INSIGHT, CONTRARIAN, DIRECT_ADDRESS
Closing: A reframe or reflection question that cements authority. No direct selling.
${lengthLine || 'TARGET LENGTH: 350–600 words. Trust posts earn authority by showing the reasoning, not just stating the conclusion. Every structural move — setup, evidence, implication — must be complete. Do not wrap up before the argument lands.'}`,
    convert: `POST GOAL: CONVERT
This post must move warm readers toward a DM, call, or next step.
Body structure: Name a specific problem → describe the solution → state the specific result → invite action
Hook preference (in order): NUMBER, STAKES, BEFORE_AFTER
Closing: One direct ask. DM, comment a word, or follow. One ask only. No "link in bio."
${lengthLine || 'TARGET LENGTH: 200–380 words. Long enough to be credible, tight enough to stay focused on the single ask. Do not bury the CTA in unnecessary setup.'}`,
  };
  return postType && blocks[postType] ? `\n${blocks[postType]}\n` : '';
}

const SPECIFICITY_MANDATE = `
SPECIFICITY RULE:
Any number, name, timeframe, or concrete detail that appears in the raw idea is sacred — preserve it verbatim, never approximate or generalise it.
Never invent statistics, metrics, or outcomes that are not in the input.
When the input has no numbers: do NOT use [SPECIFIC NEEDED] markers and do NOT invent figures. Instead, ground the post in what IS concrete — the specific scenario, the named decision, the role of the person, the direction of change, the exact moment. "I stopped sending follow-up emails entirely" is specific. "I changed my outreach approach" is not. The situation itself is the specificity — use it.
NEVER output placeholder text in square brackets (e.g. [specific result], [add detail here], [your niche], [metric]). Square brackets break the post and are never acceptable. If a concrete detail is missing, write around it naturally using the author's niche and audience context — or make a plausible inference from what is given.`;

const NARRATIVE_DEPTH_MANDATE = `
NARRATIVE DEPTH (non-negotiable):
Develop each structural move fully — not as a summary, but as a complete scene, argument, or beat.
- BEFORE state: enough specificity that the reader recognises the situation. One sentence is not enough.
- TURNING POINT: the moment must feel real and earned — name the decision, the realisation, or the result.
- AFTER state / implication: developed enough that the reader understands the change, not just that change happened.
- EVIDENCE or REASONING: one line of proof is not enough. Show the logic. Trace the consequence.
Length emerges from development — write until each structural move is complete, then stop.
Never truncate a narrative arc just to keep the post short. A post that earns its length outperforms a compressed one every time.`;

const SELF_CHECK = `
SELF-CHECK BEFORE OUTPUTTING:
1. Does line 1 stop the scroll without needing context? If not, rewrite it.
2. Is the post grounded in the concrete details from the input — a specific scenario, decision, moment, or role? If it reads as generic advice that could apply to anyone, rewrite it using the specific situation in the raw idea. Do NOT add [SPECIFIC NEEDED] markers.
3. Are any banned words or em dashes present? If yes, replace them.
4. Does the closing match the post goal? (reach=open question, trust=reframe, convert=direct ask)
5. Would someone who knows this author think "that sounds like them"? If not, rewrite.
Only output the JSON after all five pass.`;

/**
 * Generate a single alternative first line (hook B) using Haiku.
 * Gives the user a second hook option without regenerating the whole post.
 * Returns null on any failure — hook B is always non-blocking.
 */
async function generateAlternativeHook(post, usedArchetype, client) {
  try {
    const response = await client.messages.create({
      model:      HAIKU_MODEL,
      max_tokens: 80,
      system:     'You are a LinkedIn hook writer. Write one alternative opening line for a post. Under 12 words. No explanation. Plain text only.',
      messages:   [{
        role:    'user',
        content: `This post opens with a ${usedArchetype} hook:\n\n${post.split('\n').slice(0, 3).join('\n')}\n\nWrite one alternative first line using a completely different angle. Make it punchy, specific, and scroll-stopping. Plain text only — no quotes, no labels.`,
      }],
    });
    const line = response.content?.[0]?.text?.trim() || null;
    return line && line.length > 0 ? line : null;
  } catch {
    return null; // non-blocking
  }
}

/**
 * Idea path: two-stage generation (Haiku blueprint → Sonnet voice writing).
 *
 * Stage 1 (Haiku): derives tension, arc, archetype, and hook draft in one pass.
 * Stage 2 (Sonnet): writes the post with structure fixed — only voice, rhythm, specificity.
 *
 * @param {string} rawIdea
 * @param {object} userProfile
 * @param {object} [options]
 * @param {string} [options.qualityRetryHint]
 * @param {string} [options._regenerateHint]
 * @returns {Promise<{ synthesis: object, post: string, archetypeUsed: string, hookConfidence: number, stage1Blueprint: object }>}
 */
async function ideaToPost(rawIdea, userProfile, options = {}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');
  const client = new Anthropic({ apiKey });

  const archetypeOverride = options.archetypeOverride || null;
  const postType          = options.postType || null;
  const convertCtaIntent  = options.convertCtaIntent || null;

  // Stage 1 (Haiku): derive structure blueprint
  const blueprint = await (archetypeOverride
    ? Promise.resolve({
        archetype:  archetypeOverride,
        confidence: 1,
        tension:    options.tensionStatement || '',
        arc:        '',
        hook_draft: '',
      })
    : buildStructureBlueprint(rawIdea, postType, client, userProfile));

  // Caller-supplied tensionStatement takes precedence over Stage 1's derived tension
  if (options.tensionStatement) blueprint.tension = options.tensionStatement;

  const archetypeRecord = HOOK_ARCHETYPES[blueprint.archetype] || HOOK_ARCHETYPES.INSIGHT;
  const hookInjection   = buildHookInjection(archetypeRecord);
  const ctaHint         = archetypeRecord.ctaHint || null;
  const ctaInstruction  = buildCtaInstruction(postType, ctaHint, convertCtaIntent);

  return runTwoStageGeneration({
    rawIdea,
    userProfile,
    options,
    blueprint,
    hookInjection,
    archetypeUsed:  blueprint.archetype,
    hookConfidence: blueprint.confidence,
    postType,
    ctaInstruction,
  });
}

/**
 * Second option when primary hook confidence is low: same raw idea, INSIGHT archetype structure only.
 *
 * @returns {Promise<{ synthesis: object, post: string, archetypeUsed: 'INSIGHT', hookConfidence: null }>}
 */
async function generateInsightAlternativePost(rawIdea, userProfile, options = {}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const insightInjection = buildHookInjection(HOOK_ARCHETYPES.INSIGHT);

  const result = await runSinglePostGeneration({
    rawIdea,
    userProfile,
    options,
    hookInjection: insightInjection,
    archetypeUsed: 'INSIGHT',
    hookConfidence: null,
  });

  return {
    ...result,
    archetypeUsed: 'INSIGHT',
    hookConfidence: null,
  };
}

function buildTensionBlock(tension) {
  if (!tension) return '';
  return `\nCENTRAL TENSION (the only reason this post exists):
${tension}

Every sentence must earn the right to be in this post by building toward, deepening, or resolving this tension.
If a sentence does not serve the tension — cut it.
The hook opens on the tension. The body unpacks it. The close lands it.\n`;
}

function buildPhraseLibraryBlock(userProfile) {
  if (!userProfile.writing_sample_phrases) return '';
  let phrases;
  try {
    phrases = JSON.parse(userProfile.writing_sample_phrases);
  } catch {
    return '';
  }
  if (!Array.isArray(phrases) || !phrases.length) return '';
  const top = phrases
    .filter(p => p.phrase && typeof p.specificity_score === 'number')
    .sort((a, b) => b.specificity_score - a.specificity_score)
    .slice(0, 15);
  if (!top.length) return '';
  const lines = top.map(p => `• ${p.phrase}`).join('\n');
  // Type labels omitted intentionally — showing them changes how the model
  // uses phrases (weights by classification rather than natural fit).
  return `\nPHRASE LIBRARY — exact language from the author's own writing:
${lines}

Use these verbatim where they fit the shape naturally.
Do not force inclusion — if a phrase requires restructuring the argument, leave it out.\n`;
}

function buildFingerprintBlock(userProfile) {
  const fingerprint = userProfile.voice_fingerprint
    ? JSON.parse(userProfile.voice_fingerprint)
    : null;
  if (!fingerprint) return '';
  return `
VOICE FINGERPRINT (strictly follow these patterns):
- Opening style: ${fingerprint.opening_style}
- Sentence structure: ${fingerprint.sentence_structure}
- Credibility mechanism: ${fingerprint.credibility_mechanism}
- Signature moves: ${fingerprint.signature_moves?.join(', ')}
`;
}

function buildCtaInstruction(funnelType, ctaHint, convertCtaIntent = null) {
  const funnelInstructions = {
    reach:   "End with one specific question inviting the reader to share their own experience with the post's central tension. Specific beats vague — 'What did you do when X happened?' beats 'What do you think?' Do NOT use 'Thoughts?' or 'What do you think?' verbatim.",
    trust:   "End with a reflection question that challenges the reader to examine their own practice, OR a forward-facing declarative that cements your authority position. The close should feel earned, not appended.",
    convert: convertCtaIntent
      ? `End with this specific ask: "${convertCtaIntent}". Make it conversational and direct. Never 'check my link in bio' or 'check comments'.`
      : "End with a warm, low-friction invitation: 'If this resonates, send me a DM. I read every one.' or similar. One ask only. No link, no hard sell.",
  };
  const funnelInstruction = funnelInstructions[funnelType] || funnelInstructions.trust;
  const hintLine = ctaHint ? `\nARCHETYPE CTA DIRECTION: ${ctaHint}` : '';
  return `\nCLOSING:
${funnelInstruction}${hintLine}`;
}

/**
 * Stage 1 — Structural blueprint (Haiku).
 * Identifies tension, arc, archetype, and hook draft in one coherent pass.
 * Replaces the separate selectHook() + tensionExtractor calls for the idea path.
 */
async function buildStructureBlueprint(rawIdea, postType, client, userProfile = null) {
  const archetypeLines = ARCHETYPE_KEYS.map(key => `- ${key}: ${HOOK_ARCHETYPES[key].trigger}`).join('\n');
  const postTypeBlock  = postType && ARCHETYPE_POST_TYPE_PREFERENCES[postType]
    ? `\nPOST GOAL: ${postType.toUpperCase()}\nPreferred archetypes: ${ARCHETYPE_POST_TYPE_PREFERENCES[postType].join(', ')}\nWeight toward these when the input fits multiple.\n`
    : '';

  // For short inputs, inject Voice DNA so Haiku can develop the idea into the author's angle
  const voiceContextBlock = (rawIdea.length < 120 && userProfile)
    ? `\nAUTHOR CONTEXT (use to develop the idea's angle and connect it to the author's niche):\n` +
      (userProfile.content_niche   ? `Niche: ${userProfile.content_niche}\n` : '') +
      (userProfile.audience_pain   ? `Audience challenge: ${userProfile.audience_pain}\n` : '') +
      (userProfile.contrarian_view ? `Author's POV: ${userProfile.contrarian_view}\n` : '')
    : '';

  try {
    const response = await client.messages.create({
      model:       HAIKU_MODEL,
      max_tokens:  400,
      temperature: 0,
      system:      BLUEPRINT_SYSTEM_PROMPT,
      messages: [{
        role:    'user',
        content: `ARCHETYPES:\n${archetypeLines}\n${postTypeBlock}${voiceContextBlock}\nRAW IDEA:\n${rawIdea}\n\nReturn the blueprint JSON. hook_draft must reflect the actual content of this specific idea.`,
      }],
    });

    const text   = response.content[0]?.text?.trim() || '';
    const parsed = extractJsonFromResponse(text);
    const arch   = typeof parsed.archetype === 'string' && ARCHETYPE_KEYS.includes(parsed.archetype.toUpperCase())
      ? parsed.archetype.toUpperCase()
      : 'INSIGHT';

    return {
      archetype:  arch,
      confidence: typeof parsed.confidence  === 'number' ? parsed.confidence  : 0.5,
      tension:    typeof parsed.tension     === 'string' ? parsed.tension     : '',
      arc:        typeof parsed.arc         === 'string' ? parsed.arc         : '',
      hook_draft: typeof parsed.hook_draft  === 'string' ? parsed.hook_draft  : '',
    };
  } catch {
    return { archetype: 'INSIGHT', confidence: 0.5, tension: '', arc: '', hook_draft: '' };
  }
}

/**
 * Stage 2 system prompt — voice writing only.
 * Structure is fixed by the blueprint; model's only job is voice, rhythm, specificity.
 */
function buildVoiceWritingSystemPrompt(blueprint, userProfile, hookInjectionBlock, ctaInstruction = '', postType = null) {
  const { tension, arc, hook_draft, archetype } = blueprint;
  const phraseLibraryBlock = buildPhraseLibraryBlock(userProfile);
  const voiceDNABlock      = buildVoiceDNABlock(userProfile);
  const postTypeBlock      = buildPostTypeBlock(postType, archetype);

  const blueprintBlock = `
STRUCTURAL BLUEPRINT (non-negotiable — structure is decided; your job is execution):
- Core tension: ${tension || 'Identify the strongest contradiction or surprise in the raw idea'}
- Narrative arc: ${arc || 'Open on the tension, build through the evidence, land the resolution'}
- Hook opening angle: ${hook_draft || 'Lead with the most specific and surprising element'}

Write the post according to this structure. Every sentence must serve this arc.
Develop each structural move fully — do not summarise or compress. The before needs enough specificity to feel real. The turn needs to land. The after needs enough detail to show what changed. Earn the length.
`;

  return `You are writing a LinkedIn post for a professional. The structure is already decided. Your job is voice, rhythm, and specificity — nothing else.
${voiceDNABlock}${phraseLibraryBlock}${postTypeBlock}
${blueprintBlock}
${hookInjectionBlock}

CONTENT NICHE: ${userProfile.content_niche || 'not specified'}

AUDIENCE:
- Who they are: ${userProfile.audience_role || 'professionals in the author\'s field'}
- What keeps them up at night: ${userProfile.audience_pain || 'professional challenges in their field'}

LINKEDIN FORMATTING (non-negotiable):
- One sentence per line. Never write paragraph blocks. Every sentence gets its own line.
- Put a blank line between every 2–3 lines to create visual breathing room.
- The post must be visually scannable — a wall of text kills engagement before anyone reads it.

ABOVE THE FOLD (critical for reach):
- LinkedIn shows only the first 2–3 lines before the "see more" truncation.
- Line 1 is the hook — handled by the archetype instruction above.
- Lines 2–3 must deepen the tension, not explain or contextualise it.
- Avoid "not X, not Y" patterns — they are safe but flat. Instead, add a second sharp fact, a stark contrast, or a consequence that makes the hook land harder.
- Lines 2–3 should make the reader feel they will miss something if they do not click "see more".
- Never use lines 2–3 for background, setup, or "let me tell you about X" framing.

POINT OF VIEW (non-negotiable):
Take the strongest defensible position the raw idea supports — not the safest one.
Never present both sides without choosing one. A hedged first draft cannot be sharpened; a strong one can be dialled back.
If the idea contains a provocative angle, lead with it — do not bury it in the body.
${AI_TELLS_PROHIBITION}${SPECIFICITY_MANDATE}${NARRATIVE_DEPTH_MANDATE}${ctaInstruction}
${SELF_CHECK}`;
}

/**
 * Runs Stage 2 Sonnet generation with a blueprint-grounded system prompt.
 * Used exclusively by ideaToPost() — vault and editorial paths use runSinglePostGeneration().
 */
async function runTwoStageGeneration({
  rawIdea,
  userProfile,
  options,
  blueprint,
  hookInjection,
  archetypeUsed,
  hookConfidence,
  postType = null,
  ctaInstruction = '',
}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');
  const client = new Anthropic({ apiKey });

  const systemPrompt    = buildVoiceWritingSystemPrompt(blueprint, userProfile, hookInjection, ctaInstruction, postType);
  const userPrompt      = buildUserPrompt(rawIdea);
  const extraHints      = [options._funnelHint, options.qualityRetryHint, options._regenerateHint].filter(Boolean).join('\n\n');
  const userPromptFinal = extraHints ? `${userPrompt}\n\n${extraHints}` : userPrompt;

  let responseText = '';

  try {
    const message = await client.messages.create({
      model:       'claude-sonnet-4-6',
      max_tokens:  3000,
      temperature: 0.7,
      system:      systemPrompt,
      messages:    [{ role: 'user', content: userPromptFinal }],
    });

    responseText = message.content[0]?.text?.trim() || '';
    const validated = validateSinglePostResponse(extractJsonFromResponse(responseText));
    const cleanPost  = sanitiseAiTells(validated.post);
    const hookB      = await generateAlternativeHook(cleanPost, archetypeUsed, client);
    return {
      synthesis:       validated.synthesis,
      post:            cleanPost,
      hookB,
      ctaAlternatives: validated.ctaAlternatives,
      archetypeUsed,
      hookConfidence,
      stage1Blueprint: blueprint,
    };
  } catch (firstErr) {
    if (firstErr instanceof SyntaxError && responseText) {
      try {
        const retry = await client.messages.create({
          model:       'claude-sonnet-4-6',
          max_tokens:  3000,
          temperature: 0.7,
          system:      systemPrompt,
          messages: [
            { role: 'user',      content: userPromptFinal },
            { role: 'assistant', content: responseText },
            { role: 'user',      content: 'Return only valid JSON, no other text.' },
          ],
        });
        responseText = retry.content[0]?.text?.trim() || '';
        const validated = validateSinglePostResponse(extractJsonFromResponse(responseText));
        const cleanPost  = sanitiseAiTells(validated.post);
        const hookB      = await generateAlternativeHook(cleanPost, archetypeUsed, client);
        return {
          synthesis:       validated.synthesis,
          post:            cleanPost,
          hookB,
          ctaAlternatives: validated.ctaAlternatives,
          archetypeUsed,
          hookConfidence,
          stage1Blueprint: blueprint,
        };
      } catch (retryErr) {
        throw new Error(`Generation failed after retry: ${retryErr.message}`);
      }
    }
    throw firstErr;
  }
}

function buildSystemPrompt(userProfile, hookInjectionBlock, ctaInstruction = '', postType = null, tensionStatement = null, archetype = null) {
  const tensionBlock = buildTensionBlock(tensionStatement);
  const phraseLibraryBlock = buildPhraseLibraryBlock(userProfile);
  const fingerprintBlock = buildVoiceDNABlock(userProfile);
  const postTypeBlock = buildPostTypeBlock(postType, archetype);
  return `You are an editorial thinking partner for a professional who creates LinkedIn content. Your job is to take a raw idea and transform it into one polished, high-quality LinkedIn post that sounds exactly like the author — not like AI.
${tensionBlock}${phraseLibraryBlock}
${fingerprintBlock}${postTypeBlock}
${hookInjectionBlock}

GENERATION TASK — two separate jobs:

PART 1 — FIND THE SHAPE:
Build the structure that best serves the central tension above.
What sequence of moves — opening, body, close — resolves this contradiction most clearly?
The reader should arrive at the main insight through the evidence before you name it.
Do not announce the conclusion — earn it.
Do this work first. The shape is determined by the tension, not the hook archetype.

PART 2 — FIND THE VOICE:
For any claim, explanation, or description, check the phrase library above.
Use exact language where it fits the shape you built.
If no phrase fits without restructuring the argument — use plain, specific language instead.
The shape is non-negotiable. The phrases are available material.

CONTENT NICHE: ${userProfile.content_niche || 'not specified'}

AUDIENCE:
- Who they are: ${userProfile.audience_role || 'professionals in the author\'s field'}
- What keeps them up at night: ${userProfile.audience_pain || 'professional challenges in their field'}

EDITORIAL CONTEXT (use where it strengthens the post):
${userProfile.contrarian_view || 'Draw on the raw idea for tension and specificity.'}

LINKEDIN FORMATTING (non-negotiable):
- One sentence per line. Never write paragraph blocks. Every sentence gets its own line.
- Put a blank line between every 2–3 lines to create visual breathing room.
- The post must be visually scannable — a wall of text kills engagement before anyone reads it.

ABOVE THE FOLD (critical for reach):
- LinkedIn shows only the first 2–3 lines before the "see more" truncation.
- Line 1 is the hook — handled by the archetype instruction above.
- Lines 2–3 must sharpen the tension, not explain or contextualise it.
- Avoid "not X, not Y" patterns — they are safe but flat. Instead, add a second sharp fact, a stark contrast, or a consequence that makes the hook land harder.
- Lines 2–3 should make the reader feel they will miss something if they do not click "see more".
- Never use lines 2–3 for background, setup, or "let me tell you about X" framing.

POINT OF VIEW (non-negotiable):
Take the strongest defensible position the raw idea supports — not the safest one.
Never present both sides without choosing one. A hedged first draft cannot be sharpened; a strong one can be dialled back.
If the idea contains a provocative angle, lead with it — do not bury it in the body.
${AI_TELLS_PROHIBITION}${SPECIFICITY_MANDATE}${NARRATIVE_DEPTH_MANDATE}${ctaInstruction}
${SELF_CHECK}`;
}

function buildUserPrompt(rawIdea) {
  return `RAW IDEA:
${rawIdea}

EXTRACTION INSTRUCTION: Before structuring the post, identify the most concrete element in the raw idea — a specific scenario, decision, moment, named role, direction of change, or result. Build from that. If the input has no numbers, do not add or invent any — the scenario itself is the specificity. Never use [SPECIFIC NEEDED] markers. If the input is genuinely abstract with no concrete anchor, produce the strongest possible post from the material given, grounded in the author's niche and voice.

Return ONLY valid JSON in this exact structure:
{
  "synthesis": {
    "suggested_angle": "one sentence on the strongest angle for this idea",
    "recommended_structure": "one sentence on the best structure given the audience",
    "supporting_insight": "one sentence of editorial context that makes this idea stronger"
  },
  "post": "full text of the single LinkedIn post",
  "cta_alternatives": [
    "one alternative closing line — different question angle or engagement prompt",
    "one alternative closing line — soft conversion invite (DM, follow, or resource in comments)"
  ]
}

No markdown fences. No explanation. Only the JSON object.`;
}

/**
 * User prompt for trust/convert vault posts. Frames the input as expert source material
 * so Claude preserves depth and specificity rather than genericising.
 *
 * @param {object} vaultIdea
 * @param {string|null} chunkText       — primary source chunk (full text, no truncation)
 * @param {object} [options]
 * @param {string} [options.rawIdea]    — user's textarea value (may differ from seed_text if edited)
 * @param {string} [options.neighborContext] — text of adjacent chunks for surrounding context
 */
function buildVaultUserPrompt(vaultIdea, chunkText, options = {}) {
  // Use the user's textarea value if it differs meaningfully from the seed;
  // otherwise fall back to the mined seed. Preserves any extra context the user added.
  const insightText = (options.rawIdea && options.rawIdea.trim().length > 20)
    ? options.rawIdea.trim()
    : vaultIdea.seed_text;

  const sourceNote = vaultIdea.source_ref ? `\nSOURCE: ${vaultIdea.source_ref}` : '';

  // Full primary chunk — no truncation. A 500-word chunk is ~3 200 chars, well within context.
  const chunkSection = chunkText
    ? `\n\nORIGINAL PASSAGE (source text this insight was extracted from — preserve every specific number, named outcome, timeframe, and proprietary framing you find here):\n${chunkText}`
    : '';

  // Adjacent chunks give surrounding context without overwhelming the prompt.
  const neighborSection = options.neighborContext
    ? `\n\nSURROUNDING CONTEXT (passages immediately before/after the insight in the same document):\n${options.neighborContext.slice(0, 2500)}`
    : '';

  return `VAULT INSIGHT (distilled from the author's own expert source material):
${insightText}${sourceNote}${chunkSection}${neighborSection}

This insight was mined from the author's own documents.
Write a LinkedIn post that:
- Opens on the sharpest specific from the source — a number, outcome, or named scenario that is ALREADY in the text above
- Preserves depth and proprietary framing from the original passage — do NOT genericise, approximate, or replace concrete details with vague language
- Reads as the author sharing hard-won, specific knowledge — not an AI summary of it
- Every factual claim must trace back to the source text above; use [SPECIFIC NEEDED] for anything not grounded there

LENGTH: ${getLengthGuidance(vaultIdea.funnel_type)}

Return ONLY valid JSON in this exact structure:
{
  "synthesis": {
    "suggested_angle": "one sentence on the strongest angle for this idea",
    "recommended_structure": "one sentence on the best structure given the audience",
    "supporting_insight": "one sentence of editorial context that makes this idea stronger"
  },
  "post": "full text of the single LinkedIn post",
  "cta_alternatives": [
    "one alternative closing line — different question angle or engagement prompt",
    "one alternative closing line — soft conversion invite (DM, follow, or resource in comments)"
  ]
}

No markdown fences. No explanation. Only the JSON object.`;
}

/**
 * User prompt for reach vault posts. Frames the input as an angle or observation
 * to develop into a broad, relatable post — not expert material to preserve.
 *
 * @param {object} vaultIdea
 * @param {object} [options]
 * @param {string} [options.rawIdea] — user's textarea value (may differ from seed_text if edited)
 */
function buildReachUserPrompt(vaultIdea, options = {}) {
  const insightText = (options.rawIdea && options.rawIdea.trim().length > 20)
    ? options.rawIdea.trim()
    : vaultIdea.seed_text;

  return `REACH ANGLE:
${insightText}

Develop this into a LinkedIn post optimised for reach — designed to attract new audiences and spark broad engagement.

A reach post works by making the reader feel seen, surprised, or compelled to respond. It succeeds through resonance, not credentials.

Write a post that:
- Opens with a hook that stops the scroll — a tension, contradiction, or observation the reader instantly recognises
- Stays relatable and human throughout — no jargon, no credentials-flaunting, no listicle structure
- Has a clear point of view; does not hedge or stay neutral
- Sounds like a person talking, not a professional presenting
- Does NOT lecture, summarise, or explain — it provokes and connects

LENGTH: ${getLengthGuidance('reach')}

Return ONLY valid JSON in this exact structure:
{
  "synthesis": {
    "suggested_angle": "one sentence on the strongest angle for this idea",
    "recommended_structure": "one sentence on the best structure given the audience",
    "supporting_insight": "one sentence of editorial context that makes this idea stronger"
  },
  "post": "full text of the single LinkedIn post",
  "cta_alternatives": [
    "one alternative closing line — different question angle or engagement prompt",
    "one alternative closing line — soft conversion invite (DM, follow, or resource in comments)"
  ]
}

No markdown fences. No explanation. Only the JSON object.`;
}

async function runSinglePostGeneration({
  rawIdea,
  userProfile,
  options,
  hookInjection,
  archetypeUsed,
  hookConfidence,
  userPromptOverride,
  funnelType = null,
  systemOverride = null,
  postType = null,
  convertCtaIntent = null,
  tensionStatement = null,
}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');
  const client = new Anthropic({ apiKey });

  const ctaHint = HOOK_ARCHETYPES[archetypeUsed]?.ctaHint || null;
  const effectiveFunnelType = funnelType || postType;
  const ctaInstruction = buildCtaInstruction(effectiveFunnelType, ctaHint, convertCtaIntent);
  const systemPrompt = systemOverride || buildSystemPrompt(userProfile, hookInjection, ctaInstruction, postType, tensionStatement, archetypeUsed);
  let userPrompt = userPromptOverride || buildUserPrompt(rawIdea);

  const extraHints = [
    options._funnelHint,
    options.qualityRetryHint,
    options._regenerateHint,
  ].filter(Boolean).join('\n\n');
  const userPromptFinal = extraHints ? `${userPrompt}\n\n${extraHints}` : userPrompt;

  let responseText = '';

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPromptFinal }],
    });

    responseText = message.content[0]?.text?.trim() || '';
    const validated = validateSinglePostResponse(extractJsonFromResponse(responseText));
    const cleanPost = sanitiseAiTells(validated.post);
    const hookB = await generateAlternativeHook(cleanPost, archetypeUsed, client);
    return {
      synthesis:       validated.synthesis,
      post:            cleanPost,
      hookB,
      ctaAlternatives: validated.ctaAlternatives,
      archetypeUsed,
      hookConfidence,
    };
  } catch (firstErr) {
    if (firstErr instanceof SyntaxError && responseText) {
      try {
        const retry = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 3000,
          temperature: 0.7,
          system: systemPrompt,
          messages: [
            { role: 'user', content: userPromptFinal },
            { role: 'assistant', content: responseText },
            { role: 'user', content: 'Return only valid JSON, no other text.' },
          ],
        });
        responseText = retry.content[0]?.text?.trim() || '';
        const validated = validateSinglePostResponse(extractJsonFromResponse(responseText));
        const cleanPost = sanitiseAiTells(validated.post);
        const hookB = await generateAlternativeHook(cleanPost, archetypeUsed, client);
        return {
          synthesis:       validated.synthesis,
          post:            cleanPost,
          hookB,
          ctaAlternatives: validated.ctaAlternatives,
          archetypeUsed,
          hookConfidence,
        };
      } catch (retryErr) {
        throw new Error(`Generation failed after retry: ${retryErr.message}`);
      }
    }
    throw firstErr;
  }
}

function validateSinglePostResponse(parsed) {
  if (!parsed.synthesis || typeof parsed.post !== 'string' || !parsed.post.trim()) {
    throw new SyntaxError('Response missing synthesis or post string');
  }
  const s = parsed.synthesis;
  if (!s.suggested_angle || !s.recommended_structure || !s.supporting_insight) {
    throw new SyntaxError('Response synthesis missing required fields');
  }
  const ctaAlternatives = Array.isArray(parsed.cta_alternatives)
    ? parsed.cta_alternatives.filter(l => typeof l === 'string' && l.trim()).slice(0, 2)
    : [];
  return { synthesis: parsed.synthesis, post: parsed.post.trim(), ctaAlternatives };
}

/**
 * Vault path: generate a LinkedIn post from a pre-classified vault seed.
 *
 * Differences from ideaToPost:
 * - Skips Haiku hook reclassification — uses stored hook_archetype directly.
 * - Uses buildVaultUserPrompt so Claude knows the input is expert source material.
 * - Optionally includes the original chunk text for deeper context.
 *
 * @param {object} vaultIdea  — row from vault_ideas (seed_text, hook_archetype, funnel_type, source_ref)
 * @param {string|null} chunkText — raw text of the source chunk, or null
 * @param {object} userProfile
 * @param {object} [options]
 */
/**
 * Vault path: generate a LinkedIn post from a pre-classified vault seed.
 *
 * Differences from ideaToPost:
 * - Skips Haiku hook reclassification — uses stored hook_archetype directly.
 * - Uses buildVaultUserPrompt so Claude knows the input is expert source material.
 * - Passes full primary chunk text + optional neighbor context — no truncation.
 * - Skips substance check — vault ideas are grounded by definition.
 *
 * @param {object}      vaultIdea          — row from vault_ideas
 * @param {string|null} chunkText          — full text of the source chunk
 * @param {object}      userProfile
 * @param {object}      [options]
 * @param {string}      [options.rawIdea]  — user's textarea value (may differ from seed_text)
 * @param {string}      [options.neighborContext] — adjacent chunk text for surrounding context
 */
async function vaultSeedToPost(vaultIdea, chunkText, userProfile, options = {}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const archetype = vaultIdea.hook_archetype || 'INSIGHT';
  const archetypeRecord = HOOK_ARCHETYPES[archetype] || HOOK_ARCHETYPES.INSIGHT;
  const hookInjection = buildHookInjection(archetypeRecord);

  // Reach ideas: resonance/relatability prompt (no source-preservation instruction).
  // Trust/Convert: expert-source prompt with full chunk + neighbor context.
  const userPromptOverride = vaultIdea.funnel_type === 'reach'
    ? buildReachUserPrompt(vaultIdea, { rawIdea: options.rawIdea })
    : buildVaultUserPrompt(vaultIdea, chunkText, {
        rawIdea:         options.rawIdea,
        neighborContext: options.neighborContext || null,
      });

  return runSinglePostGeneration({
    rawIdea:      options.rawIdea || vaultIdea.seed_text,
    userProfile,
    options,
    hookInjection,
    archetypeUsed:  archetype,
    hookConfidence: 1.0,
    userPromptOverride,
    funnelType:     vaultIdea.funnel_type || null,
    systemOverride: null,
    postType:       options.postType || vaultIdea.funnel_type || null,
    tensionStatement: options.tensionStatement || null,
  });
}

// ---------------------------------------------------------------------------
// Editorial path: copy editor model — reshapes author's own words, adds nothing.
// ---------------------------------------------------------------------------

function buildRefineSystemPrompt(userProfile, hookInjection = null, postType = null, convertCtaIntent = null, tensionStatement = null) {
  const hookRule = hookInjection
    ? `1. HOOK (line 1): Use the archetype structure below — applied to the author's own words, not invented from scratch. The hook must surface the author's strongest idea in this structural form; do not invent new facts or angles.
${hookInjection}`
    : `1. HOOK (line 1): Identify the most compelling idea in the input. Write it as a sharp, direct opening line — tightened from the author's words. Surface the author's best line; do not invent a new angle.`;

  const postTypeBlock = buildPostTypeBlock(postType);

  const ctaRules = {
    reach:   "End with one specific question inviting the reader to share their own experience. Specific beats vague. Do NOT use 'Thoughts?' or 'What do you think?' verbatim.",
    trust:   "End with a reflection question that challenges the reader to examine their own practice, OR a forward-facing declarative that cements authority. The close must feel earned.",
    convert: convertCtaIntent
      ? `End with this specific ask: "${convertCtaIntent}". Make it conversational and direct.`
      : "End with a warm, low-friction invite to DM, reply, or follow. One ask only. No links.",
  };
  const ctaRule = postType && ctaRules[postType]
    ? `5. CTA: ${ctaRules[postType]}`
    : `5. CTA: Write one closing question that invites a specific personal memory or experience — not a generic opinion. Bad: "What do you think?" Good: "What's the hardest thing you had to unlearn in your first year leading a team?" The best CTAs make readers want to answer because they already have the answer.`;

  const tensionBlock = tensionStatement
    ? `CENTRAL TENSION TO EXPRESS:
${tensionStatement}

This is the core contradiction the post must resolve. Every structural decision — the hook, the body, the close — should serve this tension. The reader should feel it in line 1 and understand its resolution by the end.

`
    : '';

  const phraseLibraryBlock = buildPhraseLibraryBlock(userProfile);

  return `You are a copy editor for a LinkedIn professional, not a ghostwriter.

Your job is to take the author's own words and shape them into a high-impact LinkedIn post.
You sharpen what is already there. You do not add what is not.
${postTypeBlock}${tensionBlock}${phraseLibraryBlock}THE LINE YOU MUST NEVER CROSS:
- You may tighten a sentence — cut flab, strengthen verbs, remove hedging.
- You may NOT add a new fact, statistic, example, story beat, or claim the author did not provide.
- If the author said "I think pricing is something most founders get wrong", you may sharpen it to "Most founders get pricing wrong." You may not add "In my experience working with 50+ startups" if the author did not write that.
- The author's specifics (numbers, names, outcomes, timeframes) are sacred. Keep them verbatim.

SPECIFICS ARE SACRED — NO EXCEPTIONS:
Any number, percentage, named company, client role, timeframe, or measurable outcome in the source material must appear in the post VERBATIM. Never paraphrase, round, approximate, or generalise them. "31% reduction in 6 weeks for a Series B SaaS team" stays exactly that — not "around 30%", not "significant reduction", not "a fast-growing startup". If the source says it, the post says it the same way. This is what makes the post credible and unfakeable.

RULES:
${hookRule}
2. LINES 2–3 (above the fold): These are what decide whether someone clicks "see more". Do NOT use them for context, setup, or explanation. Use them to deepen the tension from the hook — a consequence, a contradiction, or a "here's why this changed everything" that makes the reader feel they'll miss something if they stop reading.
3. BODY: Every sentence must trace back to something the author wrote. You may tighten, split, or reorder — you may not invent.
4. TRIM: Remove sentences that are weak, redundant, or tangential to the central point.
${ctaRule}
6. FORMAT: One sentence per line. Blank line between every 2–3 lines. No bullet lists. No headers. No paragraph blocks.

AUTHOR CONTEXT:
- Niche: ${userProfile.content_niche || 'not specified'}
- Audience: ${userProfile.audience_role || 'professionals in the author\'s field'}
- Audience pain: ${userProfile.audience_pain || 'professional challenges in their field'}

POINT OF VIEW (non-negotiable):
Take the strongest defensible position the raw idea supports — not the safest one.
Never present both sides without choosing one. A hedged first draft cannot be sharpened; a strong one can be dialled back.
If the idea contains a provocative angle, lead with it — do not bury it in the body.

${AI_TELLS_PROHIBITION}${SPECIFICITY_MANDATE}${NARRATIVE_DEPTH_MANDATE}
${SELF_CHECK}`;
}

function buildRefineUserPrompt(sourceText, documentContext = null) {
  if (documentContext) {
    return `Use specific details, examples, and language from this source material where relevant:
<source>
${documentContext.slice(0, 2000)}
</source>

Key insight to focus on:
${sourceText}

SPECIFICITY CHECK: Before shaping the post, identify the most concrete experience, result, or data point in the insight and source. If the insight is too vague (no specific outcome, no named result, no concrete moment), mark each gap with [SPECIFIC NEEDED] in the post rather than proceeding with vague content.

INSTRUCTION:
1. Open with the strongest, most memorable idea from the insight and source material.
2. Work through the content: keep what strengthens the post, cut what doesn't.
3. Tighten prose — shorter sentences, stronger verbs, no hedging. Do not add new facts or claims beyond the source material.
4. Add one closing question that invites a specific personal memory or experience.
5. Format: one sentence per line, blank line between every 2–3 lines.

Return ONLY valid JSON:
{
  "synthesis": {
    "suggested_angle": "the core idea you surfaced as the hook",
    "recommended_structure": "one sentence on how you ordered the body",
    "supporting_insight": "the CTA question you added"
  },
  "post": "full text of the shaped LinkedIn post",
  "cta_alternatives": [
    "one alternative closing question — different angle",
    "one alternative closing question — softer or more specific"
  ]
}

No markdown fences. No explanation. Only the JSON object.`;
  }

  return `AUTHOR'S TEXT:
${sourceText}

SPECIFICITY CHECK: Before shaping the post, identify the most concrete experience, result, or data point in the author's text. If the input is too vague (no specific outcome, no named result, no concrete moment), mark each gap with [SPECIFIC NEEDED] in the post rather than proceeding with vague content.

INSTRUCTION:
1. Find the author's strongest idea. Open with it — sharpened from their words, not rewritten from scratch.
2. Work through the remaining content: keep what strengthens the post, cut what doesn't.
3. Tighten prose where needed — shorter sentences, stronger verbs, no hedging. Do not add new facts or claims.
4. Add one closing question that invites a specific personal memory or experience.
5. Format: one sentence per line, blank line between every 2–3 lines.

Return ONLY valid JSON:
{
  "synthesis": {
    "suggested_angle": "the core idea you surfaced as the hook",
    "recommended_structure": "one sentence on how you ordered the body",
    "supporting_insight": "the CTA question you added"
  },
  "post": "full text of the shaped LinkedIn post",
  "cta_alternatives": [
    "one alternative closing question — different angle",
    "one alternative closing question — softer or more specific"
  ]
}

No markdown fences. No explanation. Only the JSON object.`;
}

async function assessInputQuality(text, client, userProfile = {}) {
  const niche    = userProfile.content_niche || '';
  const audience = userProfile.audience_role || '';
  try {
    const response = await client.messages.create({
      model:       HAIKU_MODEL,
      max_tokens:  120,
      temperature: 0,
      system:      'You assess LinkedIn post inputs for quality. Return only valid JSON, nothing else.',
      messages: [{
        role:    'user',
        content: `Evaluate this LinkedIn post input on four dimensions:

1. CONCRETE SPECIFIC — does it contain a real number, named scenario, specific decision, before/after state, named role, specific moment, or particular action? "I stopped sending cold emails" is specific. "I changed my approach" is not.
2. GENUINE TENSION — does it contain a surprising outcome, unpopular opinion, personal failure, counterintuitive result, or belief contradicting conventional wisdom?
3. NICHE RELEVANCE — is this content clearly relevant to the niche "${niche || 'professional work'}" aimed at "${audience || 'professionals'}"? If no niche is set, return true.
4. NOT A CLICHÉ — is this a genuinely fresh angle? Only return false if the input is clearly a recycled overused idea ("hustle is dead", "wake up grateful", "leadership is about people not profits", "mindset is everything"). Return true if there is any specific detail or nuance.

TEXT: ${text.slice(0, 1200)}

Return only: {"has_specific": true/false, "has_tension": true/false, "has_relevance": true/false, "has_novelty": true/false}`,
      }],
    });
    const parsed = JSON.parse(response.content[0].text.trim());
    return {
      hasSpecific:  !!parsed.has_specific,
      hasTension:   !!parsed.has_tension,
      hasRelevance: niche ? (parsed.has_relevance !== false) : true,
      hasNovelty:   parsed.has_novelty !== false,
    };
  } catch {
    return { hasSpecific: true, hasTension: true, hasRelevance: true, hasNovelty: true }; // fail open
  }
}

function buildContentFeedback(quality) {
  const { hasSpecific, hasTension, hasRelevance, hasNovelty } = quality;
  const passCount = [hasSpecific, hasTension, hasRelevance, hasNovelty].filter(Boolean).length;
  if (passCount >= 3) {
    if (!hasNovelty)   return 'Consider adding a fresh angle or specific detail that makes this distinctly yours.';
    if (!hasRelevance) return 'Adding a direct reference to your specific audience or niche will strengthen the post.';
    if (!hasTension)   return 'Adding a counterintuitive element or surprising outcome will make this post more shareable.';
    if (!hasSpecific)  return 'Adding a specific moment, result, or decision will make this post significantly stronger.';
  }
  return null;
}

function buildSubstanceWarnMessage({ hasSpecific, hasTension, hasRelevance }, niche) {
  if (!hasSpecific && !hasTension) {
    const ctx = niche ? ` in ${niche}` : '';
    return `Add the specific situation${ctx} — the moment, the decision, who was involved — plus what made it surprising or counterintuitive.`;
  }
  if (!hasSpecific) return 'Add what specifically happened — the moment, the client, the number — and this post will perform significantly better.';
  if (!hasTension)  return 'What makes this surprising? Add the counterintuitive outcome, the unpopular view, or the moment where something didn\'t go as expected.';
  if (!hasRelevance) {
    const ctx = niche ? ` for ${niche} professionals` : '';
    return `This input doesn\'t clearly connect to your audience${ctx}. Add what specific problem this solves or insight it provides for them.`;
  }
  return 'Add a specific scenario and what made it surprising or valuable.';
}

function buildSubstanceBlockMessage({ hasSpecific, hasTension }, niche, userProfile) {
  const ctx = niche ? ` for someone in ${niche}` : '';
  let example = '';
  try {
    const examples = JSON.parse(userProfile.input_examples || '[]');
    if (Array.isArray(examples) && examples.length) {
      example = `\n\nFor example: "${examples[0]}"`;
    }
  } catch { /* ignore */ }
  return `This input is too general to produce a strong post. Add what specifically happened${ctx} — the situation, the decision, the result — plus what made it surprising.${example}`;
}

function buildSubstancePrompt(quality, userProfile = {}) {
  const { hasSpecific, hasTension, hasRelevance, hasNovelty } = quality;
  const passCount = [hasSpecific, hasTension, hasRelevance, hasNovelty].filter(Boolean).length;

  if (passCount >= 3) return null; // 3+ dimensions pass — generate immediately

  const niche = userProfile.content_niche || '';

  if (passCount === 2) {
    return { tier: 'warn', message: buildSubstanceWarnMessage(quality, niche) };
  }

  return { tier: 'block', message: buildSubstanceBlockMessage(quality, niche, userProfile) };
}

module.exports = { ideaToPost, generateInsightAlternativePost, vaultSeedToPost };

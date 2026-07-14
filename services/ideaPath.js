'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { db, getSetting } = require('../db');
const { extractJsonFromResponse } = require('./voiceFingerprint');
const { buildVoiceDNABlock } = require('./voiceExtraction');
const {
  AI_TELLS_PROHIBITION,
  sanitiseAiTells,
  WRITING_CRAFT_RULES,
  SPECIFICITY_MANDATE,
  SELF_CHECK,
  buildPhraseLibraryBlock,
} = require('./generationCore');
const { LINKEDIN_RULES } = require('../modules/formatIntelligence/rules');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

function firstObstacle(profile) {
  try {
    const arr = JSON.parse(profile?.audience_obstacles || '[]');
    return Array.isArray(arr) ? (arr[0] || '') : String(profile?.audience_obstacles || '');
  } catch {
    return String(profile?.audience_obstacles || '');
  }
}

function firstBelief(profile) {
  try {
    const arr = JSON.parse(profile?.brand_core_beliefs || '[]');
    return Array.isArray(arr) ? (arr[0] || '') : String(profile?.brand_core_beliefs || '');
  } catch {
    return String(profile?.brand_core_beliefs || '');
  }
}

/**
 * Fetch up to 3 of the profile's best published posts to use as voice examples.
 * Returns a formatted block string, or '' if none exist.
 */
async function fetchPublishedExamples(profileId) {
  if (!profileId) return '';
  try {
    const rows = await db.prepare(`
      SELECT content FROM generated_posts
      WHERE profile_id = ? AND status = 'published' AND content IS NOT NULL
      ORDER BY quality_score DESC, published_at DESC
      LIMIT 3
    `).all(profileId);
    if (!rows.length) return '';
    return `\nEXAMPLES — this author's actual published posts (study these first — match their rhythm, sentence length, directness, and register exactly):\n\n` +
      rows.map((r, i) => `--- Example ${i + 1} ---\n${r.content}`).join('\n\n') +
      '\n\nDo not copy these posts. Use them to calibrate voice and register only.\n';
  } catch {
    return '';
  }
}

// User-chosen post length (Short/Medium/Long pills) → explicit word bands.
// Single source of truth for every reach/convert + vault generation path so the
// pill choice actually drives output length. Ranges mirror the generate.html
// hints (Short ≤100 / Medium 120–250 / Long 300–500).
const LENGTH_BANDS = {
  Short:  '70–110 words. One sharp idea, tightly expressed. Cut anything that is not essential.',
  Medium: '120–250 words. Room to develop the idea with a clear arc, without padding.',
  Long:   '300–500 words. A fuller treatment — develop the arc completely; do not truncate to stay short.',
};

// When the user picked a length, honour it; otherwise fall back to the
// funnel-type default guidance (keeps output byte-identical for callers that
// pass no preference).
function getLengthGuidance(funnelType, lengthPreference = null) {
  if (lengthPreference && LENGTH_BANDS[lengthPreference]) return LENGTH_BANDS[lengthPreference];
  const targets = LINKEDIN_RULES.postLengthTargets;
  return (targets[funnelType] || targets.default).guidance;
}

function buildPostTypeBlock(postType, lengthPreference = null) {
  const blocks = {
    reach: `POST GOAL: REACH
This post must attract new readers outside the author's existing audience.
Closing: An open question or binary choice. No selling. No DM asks.
TARGET LENGTH: 350–560 words. Story arcs need 400+ words to land the transformation. Do not truncate the arc to stay short.`,
    trust: `POST GOAL: TRUST
This post must deepen credibility with readers who already follow the author.
Closing: A reframe or reflection question that cements authority. No direct selling.
TARGET LENGTH: 350–600 words. Trust posts earn authority by showing the reasoning, not just stating the conclusion. Every structural move must be complete. Do not wrap up before the argument lands.`,
    convert: `POST GOAL: CONVERT
This post must move warm readers toward a DM, call, or next step.
Closing: One direct ask. DM, comment a word, or follow. One ask only. No "link in bio."
TARGET LENGTH: 200–380 words. Long enough to be credible, tight enough to stay focused on the single ask. Do not bury the CTA in unnecessary setup.`,
    save: `POST GOAL: SAVE (reference-value content)
This post must be dense enough that readers bookmark it to come back to later.
Structure: numbered framework, checklist, or dense stat cluster — every line is a standalone value unit.
Closing: A bookmark nudge — "Save this for next time you [specific situation]."
TARGET LENGTH: 250–400 words. Tight and information-dense. Every sentence earns its place as reference material. No narrative padding — just the signal, compressed.`,
  };
  let block = postType && blocks[postType] ? blocks[postType] : null;
  if (!block) return '';
  // Override the block's default TARGET LENGTH line with the user's pill choice.
  // Absent a preference, the string is returned untouched (snapshot-safe).
  if (lengthPreference && LENGTH_BANDS[lengthPreference]) {
    block = block.replace(/TARGET LENGTH:[\s\S]*$/, `TARGET LENGTH: ${LENGTH_BANDS[lengthPreference]}`);
  }
  return `\n${block}\n`;
}

function buildCtaInstruction(funnelType, convertCtaIntent = null) {
  const funnelInstructions = {
    reach:   "End with a question that forces readers to take a side — one with two genuine opposing positions that people will publicly argue over. NOT 'What has been your experience?' but 'Hot take: [contrarian position from the post]. Where am I wrong?' or 'Most people do [X]. I do [Y]. Who's right?' The question must be polarising enough that readers who disagree feel compelled to say so. Do NOT use 'Thoughts?' or 'What do you think?' verbatim.",
    trust:   "End with a reflection question that challenges the reader to examine their own practice, OR a forward-facing declarative that cements your authority position. The close should feel earned, not appended.",
    convert: convertCtaIntent
      ? `End with this specific ask: "${convertCtaIntent}". Make it conversational and direct. Never 'check my link in bio' or 'check comments'.`
      : "End with a warm, low-friction invitation: 'If this resonates, send me a DM. I read every one.' or similar. One ask only. No link, no hard sell.",
    save:    "End with a bookmark nudge — one line that makes the reader want to save this for later. 'Save this for next time you [specific situation].' or 'Bookmark this before your next [relevant task].' The close should make the reader feel they will need to come back to this.",
  };
  return `\nCLOSING:\n${funnelInstructions[funnelType] || funnelInstructions.trust}`;
}

/**
 * Stage 2 system prompt — voice writing with full author context.
 */
function buildVoiceWritingSystemPrompt(userProfile, ctaInstruction = '', postType = null, examplesBlock = '', lengthPreference = null) {
  const phraseLibraryBlock = buildPhraseLibraryBlock(userProfile);
  const voiceDNABlock      = buildVoiceDNABlock(userProfile);
  const postTypeBlock      = buildPostTypeBlock(postType, lengthPreference);

  return `You are writing a LinkedIn post for a professional. You have full creative authority — structure, hook, tone, arc.
${examplesBlock}${phraseLibraryBlock}${voiceDNABlock}${postTypeBlock}

CONTENT NICHE: ${userProfile.brand_description || 'not specified'}

AUDIENCE:
- Who they are: ${userProfile.audience_description || "professionals in the author's field"}
- What keeps them up at night: ${firstObstacle(userProfile) || 'professional challenges in their field'}
${firstBelief(userProfile) ? `
EDITORIAL CONTEXT (the author's established worldview — let this colour the angle and framing):
${firstBelief(userProfile)}
` : ''}
${WRITING_CRAFT_RULES}
${AI_TELLS_PROHIBITION}${SPECIFICITY_MANDATE}${ctaInstruction}`;
}

function buildStreamingUserPrompt(rawIdea) {
  return `RAW IDEA:
${rawIdea}

OPENING: Silently draft 3 candidate first lines for this specific idea. Pick the one that would make a complete stranger stop scrolling. Write the full post starting from that line.

EXTRACTION INSTRUCTION: Before structuring the post, identify the most concrete element in the raw idea — a specific scenario, decision, moment, named role, direction of change, or result. Build from that. If the input has no numbers, do not add or invent any — the scenario itself is the specificity. Never use [SPECIFIC NEEDED] markers. If the input is genuinely abstract with no concrete anchor, produce the strongest possible post from the material given, grounded in the author's niche and voice.

Output only the post as plain text. No JSON, no labels, no explanation.`;
}

function buildUserPrompt(rawIdea) {
  return `RAW IDEA:
${rawIdea}

OPENING: Silently draft 3 candidate first lines for this specific idea. Pick the one that would make a complete stranger stop scrolling. Write the full post starting from that line.

EXTRACTION INSTRUCTION: Before structuring the post, identify the most concrete element in the raw idea — a specific scenario, decision, moment, named role, direction of change, or result. Build from that. If the input has no numbers, do not add or invent any — the scenario itself is the specificity. Never use [SPECIFIC NEEDED] markers. If the input is genuinely abstract with no concrete anchor, produce the strongest possible post from the material given, grounded in the author's niche and voice.

Output only the post as plain text. No JSON, no labels, no explanation.`;
}

/**
 * User prompt for trust/convert vault posts. Frames the input as expert source material
 * so Claude preserves depth and specificity rather than genericising.
 */
function buildVaultUserPrompt(vaultIdea, chunkText, options = {}) {
  const insightText = (options.rawIdea && options.rawIdea.trim().length > 20)
    ? options.rawIdea.trim()
    : vaultIdea.seed_text;

  const sourceNote = vaultIdea.source_ref ? `\nSOURCE: ${vaultIdea.source_ref}` : '';

  const chunkSection = chunkText
    ? `\n\nORIGINAL PASSAGE (source text this insight was extracted from — preserve every specific number, named outcome, timeframe, and proprietary framing you find here):\n${chunkText}`
    : '';

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
- Every factual claim must trace back to the source text above; if a claim cannot be grounded in the source, omit it rather than approximating or inventing

LENGTH: ${getLengthGuidance(vaultIdea.funnel_type, options.lengthPreference)}

Return ONLY valid JSON in this exact structure:
{
  "synthesis": {
    "suggested_angle": "one sentence on the strongest angle for this idea",
    "recommended_structure": "one sentence on the best structure given the audience",
    "supporting_insight": "one sentence of editorial context that makes this idea stronger"
  },
  "post": "full text of the single LinkedIn post"
}

No markdown fences. No explanation. Only the JSON object.`;
}

/**
 * User prompt for reach vault posts. Frames the input as an angle or observation
 * to develop into a broad, relatable post — not expert material to preserve.
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

LENGTH: ${getLengthGuidance('reach', options.lengthPreference)}

Return ONLY valid JSON in this exact structure:
{
  "synthesis": {
    "suggested_angle": "one sentence on the strongest angle for this idea",
    "recommended_structure": "one sentence on the best structure given the audience",
    "supporting_insight": "one sentence of editorial context that makes this idea stronger"
  },
  "post": "full text of the single LinkedIn post"
}

No markdown fences. No explanation. Only the JSON object.`;
}

async function runSinglePostGeneration({
  rawIdea,
  userProfile,
  options,
  userPromptOverride,
  funnelType       = null,
  systemOverride   = null,
  postType         = null,
  convertCtaIntent = null,
}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');
  const client = new Anthropic({ apiKey });

  const effectiveFunnelType = funnelType || postType;
  const ctaInstruction      = buildCtaInstruction(effectiveFunnelType, convertCtaIntent);
  const systemPrompt        = systemOverride || buildVoiceWritingSystemPrompt(userProfile, ctaInstruction, postType);
  const userPrompt          = userPromptOverride || buildUserPrompt(rawIdea);

  const extraHints = [options._funnelHint, options.qualityRetryHint, options._regenerateHint].filter(Boolean).join('\n\n');
  const finalPrompt = extraHints ? `${userPrompt}\n\n${extraHints}` : userPrompt;

  let responseText = '';
  try {
    const message = await client.messages.create({
      model:       'claude-sonnet-4-6',
      max_tokens:  3000,
      temperature: 0.8,
      system:      systemPrompt,
      messages:    [{ role: 'user', content: finalPrompt }],
    });
    responseText = message.content[0]?.text?.trim() || '';
    const validated = validateSinglePostResponse(extractJsonFromResponse(responseText));
    return { synthesis: validated.synthesis, post: sanitiseAiTells(validated.post), archetypeUsed: null };
  } catch (firstErr) {
    if (firstErr instanceof SyntaxError && responseText) {
      try {
        const retry = await client.messages.create({
          model:       'claude-sonnet-4-6',
          max_tokens:  3000,
          temperature: 0.8,
          system:      systemPrompt,
          messages: [
            { role: 'user', content: finalPrompt },
            { role: 'assistant', content: responseText },
            { role: 'user', content: 'Return only valid JSON, no other text.' },
          ],
        });
        responseText = retry.content[0]?.text?.trim() || '';
        const validated = validateSinglePostResponse(extractJsonFromResponse(responseText));
        return { synthesis: validated.synthesis, post: sanitiseAiTells(validated.post), archetypeUsed: null };
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
  return { synthesis: parsed.synthesis, post: parsed.post.trim() };
}

/**
 * Vault path: generate a LinkedIn post from a pre-classified vault seed.
 */
async function vaultSeedToPost(vaultIdea, chunkText, userProfile, options = {}) {
  const userPromptOverride = vaultIdea.funnel_type === 'reach'
    ? buildReachUserPrompt(vaultIdea, { rawIdea: options.rawIdea, lengthPreference: options.lengthPreference })
    : buildVaultUserPrompt(vaultIdea, chunkText, {
        rawIdea:         options.rawIdea,
        neighborContext: options.neighborContext || null,
        lengthPreference: options.lengthPreference,
      });

  return runSinglePostGeneration({
    rawIdea:         options.rawIdea || vaultIdea.seed_text,
    userProfile,
    options,
    userPromptOverride,
    funnelType:      vaultIdea.funnel_type || null,
    systemOverride:  null,
    postType:        options.postType || vaultIdea.funnel_type || null,
    convertCtaIntent: options.convertCtaIntent || null,
  });
}

// ---------------------------------------------------------------------------
// ideaToPost — direct generation path (doc uploads, free-form ideas).
// Single Sonnet call with substance pre-check.
// ---------------------------------------------------------------------------

/**
 * @param {string} rawIdea
 * @param {object} userProfile
 * @param {object} [options]
 * @returns {Promise<{ synthesis: null, post: string, archetypeUsed: null, stage1Blueprint: null, contentFeedback: string|null }>}
 */
async function ideaToPost(rawIdea, userProfile, options = {}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');
  const client = new Anthropic({ apiKey });

  const postType         = options.postType || null;
  const convertCtaIntent = options.convertCtaIntent || null;
  const lengthPreference = options.lengthPreference || null;

  const shouldCheckSubstance = !options.skipSubstanceCheck && rawIdea.trim().length >= 15;

  const [quality, examplesBlock] = await Promise.all([
    shouldCheckSubstance
      ? assessInputQuality(rawIdea, client, userProfile)
      : Promise.resolve(null),
    fetchPublishedExamples(userProfile.id),
  ]);

  let contentFeedback = null;

  if (shouldCheckSubstance && quality) {
    const substanceCheck = buildSubstancePromptForPostType(quality, userProfile, postType);
    if (substanceCheck) {
      const err = new Error('missing_substance');
      err.substancePrompt = substanceCheck.message;
      err.substanceTier   = substanceCheck.tier;
      throw err;
    }
    contentFeedback = buildContentFeedback(quality);
  }

  options.onStep?.({ step: 'writing', label: 'Writing in your voice...' });

  const ctaInstruction = buildCtaInstruction(postType, convertCtaIntent);
  const systemPrompt   = buildVoiceWritingSystemPrompt(userProfile, ctaInstruction, postType, examplesBlock, lengthPreference);
  const extraHints     = [options._funnelHint, options.qualityRetryHint, options._regenerateHint].filter(Boolean).join('\n\n');

  // ── Streaming path ──────────────────────────────────────────────────────────
  if (options.onToken) {
    const userPrompt  = buildStreamingUserPrompt(rawIdea);
    const finalPrompt = extraHints ? `${userPrompt}\n\n${extraHints}` : userPrompt;

    let fullText = '';
    const stream = client.messages.stream({
      model:       'claude-sonnet-4-6',
      max_tokens:  3000,
      temperature: 0.8,
      system:      [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages:    [{ role: 'user', content: finalPrompt }],
    });
    stream.on('text', delta => { fullText += delta; options.onToken(delta); });
    await stream.done();
    return {
      synthesis:       null,
      post:            sanitiseAiTells(fullText.trim()),
      archetypeUsed:   null,
      stage1Blueprint: null,
      contentFeedback,
    };
  }

  // ── Non-streaming path ──────────────────────────────────────────────────────
  const userPrompt  = buildUserPrompt(rawIdea);
  const finalPrompt = extraHints ? `${userPrompt}\n\n${extraHints}` : userPrompt;

  const message = await client.messages.create({
    model:       'claude-sonnet-4-6',
    max_tokens:  3000,
    temperature: 0.8,
    system:      [{ type: 'text', text: systemPrompt + '\n' + SELF_CHECK, cache_control: { type: 'ephemeral' } }],
    messages:    [{ role: 'user', content: finalPrompt }],
  });

  const post = sanitiseAiTells(message.content.find(b => b.type === 'text')?.text?.trim() || '');
  return { synthesis: null, post, archetypeUsed: null, stage1Blueprint: null, contentFeedback };
}

// ---------------------------------------------------------------------------
// Refine path — copy-editor model, reshapes the author's own words.
// ---------------------------------------------------------------------------

function buildRefineSystemPrompt(userProfile, hookInjection = null, postType = null, convertCtaIntent = null, tensionStatement = null) {
  const hookRule = hookInjection
    ? `1. HOOK (line 1): Use the structure below — applied to the author's own words, not invented from scratch.\n${hookInjection}`
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
    : `5. CTA: Write one closing question that invites a specific personal memory or experience — not a generic opinion.`;

  const tensionBlock = tensionStatement
    ? `CENTRAL TENSION TO EXPRESS:\n${tensionStatement}\n\nThis is the core contradiction the post must resolve. Every structural decision — the hook, the body, the close — should serve this tension.\n\n`
    : '';

  const phraseLibraryBlock = buildPhraseLibraryBlock(userProfile);

  return `You are a copy editor for a LinkedIn professional, not a ghostwriter.

Your job is to take the author's own words and shape them into a high-impact LinkedIn post.
You sharpen what is already there. You do not add what is not.
${postTypeBlock}${tensionBlock}${phraseLibraryBlock}THE LINE YOU MUST NEVER CROSS:
- You may tighten a sentence — cut flab, strengthen verbs, remove hedging.
- You may NOT add a new fact, statistic, example, story beat, or claim the author did not provide.
- The author's specifics (numbers, names, outcomes, timeframes) are sacred. Keep them verbatim.

SPECIFICS ARE SACRED — NO EXCEPTIONS:
Any number, percentage, named company, client role, timeframe, or measurable outcome in the source material must appear in the post VERBATIM. Never paraphrase, round, approximate, or generalise them.

RULES:
${hookRule}
2. LINES 2–3 (above the fold): Use them to deepen the tension from the hook — a consequence, a contradiction, or a consequence that makes the reader feel they'll miss something if they stop reading. Do NOT use them for context, setup, or explanation.
3. BODY: Every sentence must trace back to something the author wrote. You may tighten, split, or reorder — you may not invent.
4. TRIM: Remove sentences that are weak, redundant, or tangential to the central point.
${ctaRule}
6. FORMAT: One sentence per line. Blank line between every 2–3 lines. No bullet lists. No headers. No paragraph blocks.

AUTHOR CONTEXT:
- Niche: ${userProfile.brand_description || 'not specified'}
- Audience: ${userProfile.audience_description || "professionals in the author's field"}
- Audience pain: ${firstObstacle(userProfile) || 'professional challenges in their field'}

POINT OF VIEW (non-negotiable):
Take the strongest defensible position the raw idea supports — not the safest one.
Never present both sides without choosing one.

${AI_TELLS_PROHIBITION}${SPECIFICITY_MANDATE}`;
}

function buildRefineUserPrompt(sourceText, documentContext = null) {
  if (documentContext) {
    return `Use specific details, examples, and language from this source material where relevant:
<source>
${documentContext.slice(0, 2000)}
</source>

Key insight to focus on:
${sourceText}

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
  "post": "full text of the shaped LinkedIn post"
}

No markdown fences. No explanation. Only the JSON object.`;
  }

  return `AUTHOR'S TEXT:
${sourceText}

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
  "post": "full text of the shaped LinkedIn post"
}

No markdown fences. No explanation. Only the JSON object.`;
}

// ---------------------------------------------------------------------------
// Substance check — runs before generation to catch empty/off-topic inputs.
// ---------------------------------------------------------------------------

async function assessInputQuality(text, client, userProfile = {}) {
  const niche    = userProfile.brand_description || '';
  const audience = userProfile.audience_description || '';
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

TEXT: ${text.slice(0, 2500)}

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
    return { hasSpecific: true, hasTension: true, hasRelevance: true, hasNovelty: true };
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
  if (!hasTension)  return "What makes this surprising? Add the counterintuitive outcome, the unpopular view, or the moment where something didn't go as expected.";
  if (!hasRelevance) {
    const ctx = niche ? ` for ${niche} professionals` : '';
    return `This input doesn't clearly connect to your audience${ctx}. Add what specific problem this solves or insight it provides for them.`;
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

  if (passCount >= 3) return null;

  const niche = userProfile.brand_description || '';

  if (passCount === 2) {
    return { tier: 'warn', message: buildSubstanceWarnMessage(quality, niche) };
  }

  return { tier: 'block', message: buildSubstanceBlockMessage(quality, niche, userProfile) };
}

function buildSubstancePromptForPostType(quality, userProfile, postType) {
  const { hasSpecific, hasTension, hasNovelty } = quality;
  const niche = userProfile.brand_description || '';

  if (postType === 'reach') {
    if (hasTension || hasNovelty || hasSpecific) return null;
    return { tier: 'block', message: buildSubstanceBlockMessage(quality, niche, userProfile) };
  }

  if (postType === 'trust') {
    if (hasSpecific && (hasTension || hasNovelty)) return null;
    if (!hasSpecific && !hasTension) {
      return { tier: 'block', message: buildSubstanceBlockMessage(quality, niche, userProfile) };
    }
    return { tier: 'warn', message: buildSubstanceWarnMessage(quality, niche) };
  }

  if (postType === 'convert') {
    if (hasSpecific) return null;
    return { tier: 'warn', message: 'Convert posts anchor in a real result. Add what specifically happened — before, after, and what changed.' };
  }

  return buildSubstancePrompt(quality, userProfile);
}

// ---------------------------------------------------------------------------
// Post improver — surgical editing, only changes what was asked.
// ---------------------------------------------------------------------------

function buildImproveSystemPrompt(userProfile) {
  const phraseLibraryBlock = buildPhraseLibraryBlock(userProfile);

  return `You are a surgical copy editor for a LinkedIn professional.

Your job: apply the requested change — and ONLY that change.

SCOPE RULE (non-negotiable):
Every part of the post not addressed by the user's instruction stays VERBATIM.
Same words, same order, same structure, same line breaks.
If the user asks for a sharper hook, only line 1 changes. Every other line is copied exactly.
If the user asks to make it shorter, remove weak lines — do not restructure what remains.
If the user asks for stronger verbs, swap the verbs — keep the rest identical.

WHAT YOU MUST NEVER DO UNLESS EXPLICITLY ASKED:
- Do not rewrite the CTA
- Do not restructure body paragraphs
- Do not reformat or change line breaks
- Do not change tone, voice, or point of view
- Do not add new facts, examples, or claims not already in the post

AUTHOR CONTEXT (for tone reference — do not restructure to match):
- Niche: ${userProfile.brand_description || 'not specified'}
- Audience: ${userProfile.audience_description || 'professionals'}
- Audience pain: ${firstObstacle(userProfile) || 'professional challenges'}
${phraseLibraryBlock}
SPECIFICS ARE SACRED:
Any number, percentage, named company, role, timeframe, or measurable outcome stays verbatim — never approximate, round, or paraphrase.

${AI_TELLS_PROHIBITION}`;
}

module.exports = { ideaToPost, vaultSeedToPost, buildRefineSystemPrompt, buildImproveSystemPrompt, fetchPublishedExamples, buildVoiceWritingSystemPrompt };

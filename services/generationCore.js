'use strict';

/**
 * services/generationCore.js — single source of truth for the authenticity core
 * and shared author-context assembly used by every LinkedIn post generator.
 *
 * Before this module existed, the good authenticity controls (AI-tell prohibition,
 * specificity mandate, self-check, hook/depth/POV/formatting craft rules, phrase
 * library) lived ONLY inside services/ideaPath.js, while the 10 dedicated post-type
 * services (services/*Path.js) each carried a "Justin Welsh" persona prompt, a
 * mandated 3-hashtag block, and their own ~50-line copy of buildAuthorContext().
 *
 * Consolidating here means: (1) ideaPath.js and the post-type engine share ONE
 * authenticity core with no drift, and (2) the 10 duplicated author-context builders
 * collapse into one. See sprint-authenticity-pipeline.md (Phase 1).
 *
 * The craft-rule strings below are extracted VERBATIM from ideaPath.js's
 * buildVoiceWritingSystemPrompt so that ideaPath's assembled prompt is byte-identical
 * after it switches to importing them (verified by tests/unit/generationCore.test.js).
 */

const { AI_TELLS_PROHIBITION, sanitiseAiTells } = require('./postSanitiser');

// ---------------------------------------------------------------------------
// Craft rules — hook, above-the-fold, depth, point-of-view, formatting.
// Each block carries no leading/trailing newline; compose with '\n\n'.
// ---------------------------------------------------------------------------

const HOOK_RULES = `HOOK (first line — non-negotiable):
- Under 15 words. A complete stranger must stop scrolling on line 1 alone, with no context.
- Lead with the most specific, surprising, or contradictory element of the idea.
- Never open with "I am", "We", "Here", "In today", or "If you" — these are announcement openers, not hooks.`;

const ABOVE_THE_FOLD = `ABOVE THE FOLD:
- LinkedIn shows only the first 2–3 lines before "see more". 60–70% of readers never tap through.
- Lines 2–3 must deepen the tension from line 1 — not explain, contextualise, or set up.
- Make the reader feel they will miss something important if they do not keep reading.`;

const DEPTH_RULE = `DEPTH:
- Save the sharpest, most surprising insight for the final third of the body.
- Readers who finish should feel rewarded. Front-load enough to keep them reading — back-load the best line to make finishing worth it.`;

const POV_RULE = `POINT OF VIEW (non-negotiable):
Take the strongest defensible position the raw idea supports — not the safest one.
Never present both sides without choosing one. A hedged first draft cannot be sharpened; a strong one can be dialled back.
If the idea contains a provocative angle, lead with it — do not bury it in the body.`;

const FORMATTING_RULE = `LINKEDIN FORMATTING (non-negotiable):
- One sentence per line. Never write paragraph blocks. Every sentence gets its own line.
- Put a blank line between every 2–3 lines to create visual breathing room.
- The post must be visually scannable — a wall of text kills engagement before anyone reads it.`;

// Composed craft-rules region — matches lines 151–173 of the pre-refactor
// buildVoiceWritingSystemPrompt exactly (single blank line between each block).
const WRITING_CRAFT_RULES = [HOOK_RULES, ABOVE_THE_FOLD, DEPTH_RULE, POV_RULE, FORMATTING_RULE].join('\n\n');

// Leading '\n' preserved from the original const so callers can concatenate it
// directly after AI_TELLS_PROHIBITION exactly as ideaPath.js did.
const SPECIFICITY_MANDATE = `
SPECIFICITY RULE:
Any number, name, timeframe, or concrete detail that appears in the raw idea is sacred — preserve it verbatim, never approximate or generalise it.
Never invent statistics, metrics, or outcomes that are not in the input.
When the input has no numbers: do NOT use [SPECIFIC NEEDED] markers and do NOT invent figures. Instead, ground the post in what IS concrete — the specific scenario, the named decision, the role of the person, the direction of change, the exact moment. "I stopped sending follow-up emails entirely" is specific. "I changed my outreach approach" is not. The situation itself is the specificity — use it.
NEVER output placeholder text in square brackets (e.g. [specific result], [add detail here], [your niche], [metric]). Square brackets break the post and are never acceptable. If a concrete detail is missing, write around it naturally using the author's niche and audience context — or make a plausible inference from what is given.`;

const SELF_CHECK = `
SELF-CHECK BEFORE OUTPUTTING:
1. Does line 1 stop the scroll without needing context? If not, rewrite it.
2. Is the post grounded in the concrete details from the input — a specific scenario, decision, moment, or role? If it reads as generic advice that could apply to anyone, rewrite it using the specific situation in the raw idea. Do NOT add [SPECIFIC NEEDED] markers.
3. Are any banned words or em dashes present? If yes, replace them.
4. Does the closing match the post goal? (reach=debate question, trust=reframe, convert=direct ask, save=bookmark nudge)
5. Would someone who knows this author think "that sounds like them"? If not, rewrite.
6. Is the sharpest, most surprising insight placed in the final third of the body — not given away in the setup? If the best line appears in the first half, move it down.
Output only the post as plain text after all six pass. No JSON. No labels. No explanation.`;

// Provenance contract (Phase 4): specifics may only come from the author's real
// material. Input segments wrapped in [AI-SUGGESTED]…[/AI-SUGGESTED] are angles or
// prompts, never facts. Everything else in the input is the author's own material.
const AI_SUGGESTED_OPEN  = '[AI-SUGGESTED]';
const AI_SUGGESTED_CLOSE = '[/AI-SUGGESTED]';

const PROVENANCE_RULE = `
PROVENANCE (specifics must be real):
Text wrapped in ${AI_SUGGESTED_OPEN} ... ${AI_SUGGESTED_CLOSE} is a suggested angle or prompt to steer direction ONLY. Never treat it as fact. Never lift a number, percentage, statistic, name, date, quote, or named outcome out of it.
Everything else in the input is the author's own material — its specifics are real and you may use them.
If no concrete specific (a real number, a named client, an actual outcome) exists anywhere in the author's own material, write the post WITHOUT inventing one. A grounded post with no statistic beats a smooth post with a fabricated one.`;

/**
 * Return the author's real material from a raw idea: everything EXCEPT the text
 * inside [AI-SUGGESTED]…[/AI-SUGGESTED] blocks. Used by the FABRICATED_SPECIFIC
 * quality-gate check to decide which numbers in a generated post are grounded.
 * @param {string} rawIdea
 * @returns {string}
 */
function extractAuthorRealText(rawIdea) {
  if (!rawIdea) return '';
  return String(rawIdea)
    .replace(/\[AI-SUGGESTED\][\s\S]*?\[\/AI-SUGGESTED\]/g, ' ')
    .trim();
}

// New in the consolidation: frameworks/checklists legitimately enumerate, which
// otherwise collides with the "no three parallel points" rule in AI_TELLS_PROHIBITION.
const ENUMERATION_CARVEOUT = `STRUCTURE EXCEPTION (numbered lists):
When the post's job is to deliver a framework, checklist, or step-by-step method, a numbered or dashed list IS the right format — enumerate freely.
The "no three parallel points of equal length" rule applies to narrative and commentary, not to a reference list the reader will scan or save.
Vary the length and phrasing of list items so they read as hand-written, not templated.`;

/**
 * Assemble the authenticity core the post-type engine injects into every system
 * prompt. Combines craft rules + AI-tell prohibition + specificity mandate, with
 * an optional enumeration carve-out (framework/save formats) and self-check.
 *
 * @param {{ allowEnumeration?: boolean, includeSelfCheck?: boolean, includeCraftRules?: boolean }} [opts]
 * @returns {string}
 */
function buildAuthenticityCore({
  allowEnumeration = false,
  includeSelfCheck = false,
  includeCraftRules = true,
} = {}) {
  // Hook/above-the-fold/depth/POV/formatting rules. Opt out for goodwill formats
  // (e.g. announcements/greetings) where a scroll-stopping hook and a forced
  // point-of-view would fight the intent — the AI-tell and specificity guards
  // below still apply universally.
  const parts = [];
  if (includeCraftRules) parts.push(WRITING_CRAFT_RULES);
  if (allowEnumeration)  parts.push(ENUMERATION_CARVEOUT);
  // AI_TELLS_PROHIBITION and SPECIFICITY_MANDATE both carry a leading newline, so
  // concatenate (not join) them to reproduce the original in-template spacing.
  let core = parts.join('\n\n');
  core += `${core ? '\n' : ''}${AI_TELLS_PROHIBITION}${SPECIFICITY_MANDATE}`;
  core += `\n${PROVENANCE_RULE}`;
  if (includeSelfCheck) core += `\n${SELF_CHECK}`;
  return core;
}

// ---------------------------------------------------------------------------
// Phrase library — the author's own verbatim phrasing, ranked by specificity.
// Moved verbatim from ideaPath.js so the post-type engine can use it too.
// ---------------------------------------------------------------------------

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
    .slice(0, 5);
  if (!top.length) return '';
  const lines = top.map(p => `• ${p.phrase}`).join('\n');
  return `\nPHRASE LIBRARY — exact language from the author's own writing (study these first):
${lines}

Study these samples before writing. Match the rhythm, directness, and vocabulary — not the content.
Use verbatim phrases where they fit naturally; never force inclusion or restructure the argument to accommodate one.\n`;
}

// ---------------------------------------------------------------------------
// Shared author context — merges the 10 identical buildAuthorContext() copies
// that lived in each services/*Path.js. Byte-identical to those (resultsPath
// differed only in comments). Adds the phrase library, which the copies lacked.
// ---------------------------------------------------------------------------

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * @param {object} profile
 * @param {{ includePhraseLibrary?: boolean }} [opts]
 * @returns {string}
 */
function buildSharedAuthorContext(profile, { includePhraseLibrary = true } = {}) {
  const lines = ['## AUTHOR CONTEXT', 'You are writing for a real person. Match their voice and register precisely.', ''];

  // Brand voice
  const brandLines = [];
  if (profile.brand_description)        brandLines.push(`- What they do: ${profile.brand_description}`);
  if (profile.brand_industry)           brandLines.push(`- Industry: ${profile.brand_industry}`);
  const traits = parseJsonArray(profile.brand_personality_traits);
  if (traits.length)                    brandLines.push(`- Personality: ${traits.join(', ')}`);
  if (profile.brand_emotional_tone)     brandLines.push(`- Tone: ${profile.brand_emotional_tone}`);
  if (profile.brand_archetype)          brandLines.push(`- Archetype: ${profile.brand_archetype}`);
  const beliefs = parseJsonArray(profile.brand_core_beliefs);
  if (beliefs.length)                   brandLines.push(`- Core beliefs:\n${beliefs.map(b => `  - ${b}`).join('\n')}`);
  const phrases = parseJsonArray(profile.brand_phrases_to_use);
  if (phrases.length)                   brandLines.push(`- Phrases to weave in: ${phrases.map(p => `"${p}"`).join(', ')}`);
  if (profile.brand_story_origin)       brandLines.push(`- Their story: ${profile.brand_story_origin}`);
  if (profile.elevator_main_result)     brandLines.push(`- What they deliver: ${profile.elevator_main_result}${profile.elevator_mechanism ? ` — how: ${profile.elevator_mechanism}` : ''}`);

  if (brandLines.length) {
    lines.push('BRAND VOICE:', ...brandLines, '');
  }

  // Audience
  const audLines = [];
  if (profile.audience_description)           audLines.push(`- Who they are: ${profile.audience_description}`);
  const goals = parseJsonArray(profile.audience_goals);
  if (goals.length)                            audLines.push(`- What they want:\n${goals.map(g => `  - ${g}`).join('\n')}`);
  const obstacles = parseJsonArray(profile.audience_obstacles);
  if (obstacles.length)                        audLines.push(`- What blocks them:\n${obstacles.map(o => `  - ${o}`).join('\n')}`);
  const mktBeliefs = parseJsonArray(profile.audience_core_beliefs_market);
  if (mktBeliefs.length)                       audLines.push(`- Their market beliefs:\n${mktBeliefs.map(b => `  - ${b}`).join('\n')}`);
  if (profile.audience_buying_stage)           audLines.push(`- Awareness stage: ${profile.audience_buying_stage}`);
  if (profile.audience_market_sophistication)  audLines.push(`- Market sophistication: ${profile.audience_market_sophistication}`);

  if (audLines.length) {
    lines.push(
      'AUDIENCE RESONANCE (non-negotiable):',
      'This post must land for THIS specific reader — not a generic professional.',
      'Before writing, pick the ONE belief, desire, or problem below that this idea speaks to',
      'most directly. Root the whole post in it:',
      '- Name the problem in the reader\'s own words, the way they\'d describe it to a peer.',
      '- Mirror how they already think about it — meet them at their current belief, then move it.',
      '- Tie the payoff to what they actually want, not to what the author sells.',
      'The reader should feel this was written for them. Do NOT gesture at the whole list —',
      'commit to the one or two dimensions that fit this idea.',
      '',
      'TARGET AUDIENCE:', ...audLines, ''
    );
  }

  // Authority proof
  const authStatements = parseJsonArray(profile.authority_statements).slice(0, 3);
  if (authStatements.length) {
    lines.push('AUTHORITY PROOF (use only when it fits naturally — never force it):',
      ...authStatements.map(s => `- ${s}`), '');
  }

  // Voice DNA
  if (profile.voice_fingerprint) {
    lines.push('VOICE DNA (distilled voice signature — replicate this tone and register exactly):',
      profile.voice_fingerprint, '');
  }

  let out = lines.join('\n');

  // Phrase library — the copies never included this; add it so the post-type
  // engine gets the author's verbatim phrasing the way ideaPath.js does.
  if (includePhraseLibrary) {
    const phraseBlock = buildPhraseLibraryBlock(profile);
    if (phraseBlock) out += `\n${phraseBlock.trimStart()}`;
  }

  return out;
}

module.exports = {
  // Re-exports so callers have a single import site.
  AI_TELLS_PROHIBITION,
  sanitiseAiTells,
  // Craft-rule blocks (individual + composed).
  HOOK_RULES,
  ABOVE_THE_FOLD,
  DEPTH_RULE,
  POV_RULE,
  FORMATTING_RULE,
  WRITING_CRAFT_RULES,
  SPECIFICITY_MANDATE,
  SELF_CHECK,
  ENUMERATION_CARVEOUT,
  PROVENANCE_RULE,
  AI_SUGGESTED_OPEN,
  AI_SUGGESTED_CLOSE,
  extractAuthorRealText,
  buildAuthenticityCore,
  // Author context + phrase library.
  buildPhraseLibraryBlock,
  buildSharedAuthorContext,
};

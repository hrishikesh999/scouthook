'use strict';

// ---------------------------------------------------------------------------
// Gate 1 — Generic hook patterns
// ---------------------------------------------------------------------------
const GENERIC_HOOK_PATTERNS = [
  /in today'?s (fast.paced|competitive|digital)/i,
  /as (a|an) (founder|consultant|leader|professional) i'?ve? learned/i,
  /let'?s (be honest|talk about|discuss)/i,
  /this is your reminder/i,
  /nobody (talks about|is talking about) this/i,
  /game.changer/i,
  /in (a world where|today'?s world)/i,
  /the (truth|reality) (is|about)/i,
];

const GENERIC_HOOK_NICHE_EXCLUSIONS = {
  finance: [/unpopular opinion/i],
  startup: [/unpopular opinion/i, /hot take/i],
};

// ---------------------------------------------------------------------------
// Gate 2 — Unattributed claim patterns
// Skipped for idea + recipe paths (personal experience needs no external source)
// ---------------------------------------------------------------------------
const SOURCE_KEYWORDS = /according to|study|research|report|data from|found that|shows that|per |source:|survey/i;

// ---------------------------------------------------------------------------
// Gate 3 — AI tone patterns
// ---------------------------------------------------------------------------
const AI_TONE_PATTERNS = [
  /it'?s (important|crucial|essential|vital) to/i,
  /in conclusion/i,
  /in summary/i,
  /it'?s worth noting/i,
  /as we navigate/i,
  /the (landscape|ecosystem) (is|has)/i,
  /leverage (your|our|the)/i,
  /at the end of the day/i,
  /dive (deep|deeper) into/i,
  /unpack (this|that|the)/i,
];

const AI_TONE_FORMAT_EXCLUSIONS = {
  stat_hook: [/it'?s worth noting/i],
};

// ---------------------------------------------------------------------------
// Scoring weights
// ---------------------------------------------------------------------------
const GATE_WEIGHTS = {
  generic_hook: 30,
  unattributed_claim: 40,
  ai_tone: 30,
};

/**
 * Run all 3 quality gate checks on a generated post.
 *
 * @param {string} content — post text
 * @param {object} userProfile — { content_niche, ... }
 * @param {string} formatSlug — 'stat_hook' | 'hot_take' | 'story'
 * @param {string} path — 'idea' | 'recipe' | 'research'
 * @returns {{ score: number, flags: string[], passed_gate: boolean }}
 */
function runQualityGate(content, userProfile, formatSlug, path) {
  const flags = [];
  const niche = (userProfile?.content_niche || '').toLowerCase();

  // Gate 1 — Generic hook (check first 20 words)
  const first20Words = content.split(/\s+/).slice(0, 20).join(' ');
  const nicheExclusions = GENERIC_HOOK_NICHE_EXCLUSIONS[niche] || [];
  const genericHookHit = GENERIC_HOOK_PATTERNS.some(pattern => {
    if (nicheExclusions.some(ex => ex.test(first20Words))) return false;
    return pattern.test(first20Words);
  });
  if (genericHookHit) flags.push('generic_hook');

  // Gate 2 — Unattributed claim (skipped for idea + recipe paths)
  if (path === 'research') {
    const hasNumber = /\d+(%|x|times|\s?(million|billion|thousand))/i.test(content);
    const hasSource = SOURCE_KEYWORDS.test(content);
    if (hasNumber && !hasSource) flags.push('unattributed_claim');
  }

  // Gate 3 — AI tone
  const formatExclusions = AI_TONE_FORMAT_EXCLUSIONS[formatSlug] || [];
  const aiToneHit = AI_TONE_PATTERNS.some(pattern => {
    if (formatExclusions.some(ex => ex.source === pattern.source)) return false;
    return pattern.test(content);
  });
  if (aiToneHit) flags.push('ai_tone');

  const score = 100 - flags.reduce((sum, flag) => sum + (GATE_WEIGHTS[flag] || 0), 0);
  const passed_gate = score >= 70;

  return { score, flags, passed_gate };
}

module.exports = { runQualityGate };

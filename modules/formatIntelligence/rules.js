'use strict';

/**
 * LinkedIn format rules — single source of truth for quality gate.
 * Imported by services/qualityGate.js only; do not duplicate elsewhere.
 */

const LINKEDIN_RULES = {
  blocklist: [
    'game changer',
    'game-changer',
    'synergy',
    'circle back',
    'move the needle',
    'low-hanging fruit',
    'think outside the box',
    'at the end of the day',
    'best in class',
    'win-win',
  ],
  hook: {
    maxWords: 15,
    /** First-line prefixes (case-insensitive) that read as weak LinkedIn openers */
    forbiddenStarters: [
      'i am excited to',
      "i'm excited to",
      'i am thrilled',
      "i'm thrilled",
      'i am pleased',
      "i'm pleased",
      'today i want to',
      "today i'd like",
      "i'd like to share",
      'i would like to share',
      'i am writing to',
    ],
  },
  post: {
    maxHashtags: 3,
    minWords: 150,
    maxWords: 500,
  },

  /** Target word counts by funnel type — injected into generation prompts */
  postLengthTargets: {
    reach:   { min: 100, max: 200, guidance: 'Keep it punchy and conversational — 100 to 200 words. Reach posts lose tension when they run long.' },
    trust:   { min: 280, max: 420, guidance: 'Develop the idea fully — 280 to 420 words. Trust posts earn authority by showing the reasoning, not just stating the conclusion. Do not wrap up before the argument is complete.' },
    convert: { min: 180, max: 320, guidance: 'Be specific enough to paint the transformation clearly — 180 to 320 words. Long enough to be credible, tight enough to stay focused.' },
    default: { min: 150, max: 350, guidance: 'Develop the idea fully — 150 to 350 words. Do not truncate before the idea is complete.' },
  },
};

module.exports = { LINKEDIN_RULES };

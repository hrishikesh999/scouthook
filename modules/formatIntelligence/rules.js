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
    minWords: 4,
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
    reach:   { min: 200, max: 500, guidance: 'Develop the narrative fully — 200 to 500 words depending on the archetype. Story archetypes (BEFORE_AFTER, CONFESSION) need 400+ words; insight or pattern-interrupt hooks can be 200–350. Do not truncate before the arc is complete.' },
    trust:   { min: 350, max: 600, guidance: 'Develop the idea fully — 350 to 600 words. Trust posts earn authority by showing the reasoning, not just stating the conclusion. Every structural move — setup, evidence, implication — must be complete. Do not wrap up before the argument lands.' },
    convert: { min: 200, max: 380, guidance: 'Be specific enough to paint the transformation clearly — 200 to 380 words. Long enough to be credible, tight enough to stay focused on the single ask.' },
    default: { min: 200, max: 500, guidance: 'Develop the idea fully — 200 to 500 words. Develop each structural move until the arc is complete. Do not truncate.' },
  },
};

module.exports = { LINKEDIN_RULES };

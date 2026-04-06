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
    minWords: 50,
    maxWords: 300,
  },
};

module.exports = { LINKEDIN_RULES };

'use strict';

// Regression guard for the Phase 1 refactor: ideaPath.js now composes its system
// prompt from services/generationCore.js instead of local const copies. These
// snapshots were captured from the pre-refactor build and must stay byte-identical.
// Requires ideaPath (→ db.js), so runs under NODE_ENV=test with .env.test loaded.
const fs = require('fs');
const path = require('path');
const { buildVoiceWritingSystemPrompt } = require('../../services/ideaPath');
const profile = require('../fixtures/voiceProfile');

const FIX = path.join(__dirname, '..', 'fixtures', 'prompts');

const VARIANTS = [
  ['trust_cta',   () => buildVoiceWritingSystemPrompt(profile, '\nCLOSING:\nEnd with a reflection question.', 'trust', '\nEXAMPLES BLOCK\n')],
  ['reach_nocta', () => buildVoiceWritingSystemPrompt(profile, '', 'reach', '')],
  ['save_cta',    () => buildVoiceWritingSystemPrompt(profile, '\nCLOSING:\nBookmark nudge.', 'save', '')],
];

describe('ideaPath system prompt — byte-identical to pre-refactor baseline', () => {
  for (const [name, build] of VARIANTS) {
    test(name, () => {
      const baseline = fs.readFileSync(path.join(FIX, `ideaPath_${name}.baseline.txt`), 'utf8');
      expect(build()).toBe(baseline);
    });
  }
});

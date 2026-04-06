'use strict';

const assert = require('assert');
const { runQualityGate } = require('../services/qualityGate');

const emptyProfile = {};

// Test 1 — blocklist / cliché
{
  const r = runQualityGate('This is a game changer for our team.\n\nRest of post here with enough words to pass minimums maybe not.', {
    voiceProfile: emptyProfile,
  });
  assert.strictEqual(r.passed, false);
  assert.ok(r.flags.includes('CLICHE_DETECTED'));
}

// Test 2 — hook too long + weak opener
{
  const post =
    'I am excited to share some thoughts about strategy today which I have been thinking about\n\n' +
    'Body line two.\n\n' +
    'More body content here to satisfy word count requirements for the quality gate module test suite we are building today.';
  const r = runQualityGate(post, { voiceProfile: emptyProfile });
  assert.strictEqual(r.passed, false);
  assert.ok(r.flags.includes('HOOK_TOO_LONG'));
  assert.ok(r.flags.includes('WEAK_HOOK_OPENER'));
}

// Test 3 — AI language (two phrases → score below 50)
{
  const post =
    'As an AI language model I will explain. In conclusion, here is my take.\n\n' +
    'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
    'Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor.';
  const r = runQualityGate(post, { voiceProfile: emptyProfile });
  assert.strictEqual(r.passed, false);
  assert.ok(r.flags.includes('AI_LANGUAGE_DETECTED'));
  assert.ok(r.score < 50, `expected score < 50, got ${r.score}`);
}

// Test 4 — hashtag spam
{
  const tags = '#one #two #three #four #five #six';
  const body =
    'Opening line here for the test.\n\n' +
    'Paragraph with enough words to meet minimum post length for linkedin rules in this test suite. '.repeat(4);
  const r = runQualityGate(`${body}\n\n${tags}`, { voiceProfile: emptyProfile });
  assert.strictEqual(r.passed, false);
  assert.ok(r.flags.includes('HASHTAG_SPAM'));
}

// Test 5 — clean pass (score > 75)
{
  const post =
    'Short punchy hook here.\n\n' +
    'This paragraph develops the idea with concrete detail so readers stay engaged from start to finish. '.repeat(3) +
    'We explore what matters for professionals who want clarity without fluff in their daily reading habits. ' +
    'The goal is to deliver value in every sentence while respecting the reader time and attention span carefully. ' +
    'That means structure rhythm and a point that lands before the scroll continues endlessly without purpose.\n\n' +
    'What is one change you will make this week?\n\n' +
    '#leadership #strategy #growth';
  const r = runQualityGate(post, { voiceProfile: emptyProfile });
  assert.strictEqual(r.passed, true);
  assert.ok(r.score > 75, `expected score > 75, got ${r.score}`);
}

// Test 6 — NUMBER archetype mismatch (warning only)
{
  const post =
    'No digits in this hook line\n\n' +
    'Supporting content with enough words to avoid the too short warning in the quality gate. '.repeat(3) +
    'We keep building sentences until we cross the minimum threshold required by linkedin rules for post length.\n\n' +
    'Does this resonate with your experience?';
  const r = runQualityGate(post, {
    voiceProfile: emptyProfile,
    archetypeUsed: 'NUMBER',
    hookConfidence: 0.8,
  });
  assert.strictEqual(r.passed, true);
  assert.ok(r.flags.includes('ARCHETYPE_MISMATCH'));
}

// Test 7 — no closing question (warning) but still passes
{
  const post =
    'A clear hook opens this post.\n\n' +
    'Body text continues with substance and enough words to satisfy minimum length for linkedin quality rules. '.repeat(3) +
    'We avoid clichés and keep the tone direct for professional readers who scan quickly on mobile devices daily.\n\n' +
    'Thanks for reading.\n\n' +
    '#professional #insight #career';
  const r = runQualityGate(post, { voiceProfile: emptyProfile });
  assert.strictEqual(r.passed, true);
  assert.ok(r.flags.includes('NO_CLOSING_QUESTION'));
}

// Test 8 — two clichés + long hook → score below 60
{
  const post =
    'This opening line has far too many words packed into a single sentence so that the hook length check will fail hard here synergy win-win\n\n' +
    'Extra body text to add some words without triggering other hard failures in the gate.';
  const r = runQualityGate(post, { voiceProfile: emptyProfile });
  assert.ok(r.score < 60, `expected score < 60, got ${r.score}`);
}

console.log('qualityGate.test.js: all 8 tests passed');

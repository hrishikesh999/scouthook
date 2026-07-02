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

// Test 3 — AI language (two phrases → significant score penalty, failed gate)
// Scoring: -30 AI giveaway, -45 TOO_SHORT (pct<0.4), -8 NO_CTA = 17 → below 60
{
  const post =
    'As an AI language model I will explain. In conclusion, here is my take.\n\n' +
    'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
    'Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor.';
  const r = runQualityGate(post, { voiceProfile: emptyProfile });
  assert.strictEqual(r.passed, false);
  assert.ok(r.flags.includes('AI_LANGUAGE_DETECTED'));
  assert.ok(r.score < 60, `expected score < 60, got ${r.score}`);
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

// Test 5 — clean pass (score > 75, passed = true)
// Body needs 150+ words: 4 + 16×6 + 17 + 18 + 16 + 9 + 3 = 163 words
{
  const post =
    'Short punchy hook here.\n\n' +
    'This paragraph develops the idea with concrete detail so readers stay engaged from start to finish. '.repeat(6) +
    'We explore what matters for professionals who want clarity without fluff in their daily reading habits. ' +
    'The goal is to deliver value in every sentence while respecting the reader time and attention span carefully. ' +
    'That means structure rhythm and a point that lands before the scroll continues endlessly without purpose.\n\n' +
    'What is one change you will make this week?\n\n' +
    '#leadership #strategy #growth';
  const r = runQualityGate(post, { voiceProfile: emptyProfile });
  assert.strictEqual(r.passed, true, `expected passed=true, flags=${r.flags}`);
  assert.ok(r.score > 75, `expected score > 75, got ${r.score}`);
}

// Test 6 — no closing question (warning only — post still passes)
// Body needs 150+ words: 6 + 16×8 + 18 + 3 + 3 = 158 words
{
  const post =
    'A clear hook opens this post.\n\n' +
    'Body text continues with substance and enough words to satisfy minimum length for linkedin quality rules. '.repeat(8) +
    'We avoid the temptation of generic filler and keep the tone direct for professional readers who scan quickly.\n\n' +
    'Thanks for reading.\n\n' +
    '#professional #insight #career';
  const r = runQualityGate(post, { voiceProfile: emptyProfile });
  assert.strictEqual(r.passed, true, `expected passed=true, flags=${r.flags}`);
  assert.ok(r.flags.includes('NO_CTA'));
}

// Test 7 — two clichés + long hook → score below 60
{
  const post =
    'This opening line has far too many words packed into a single sentence so that the hook length check will fail hard here synergy win-win\n\n' +
    'Extra body text to add some words without triggering other hard failures in the gate.';
  const r = runQualityGate(post, { voiceProfile: emptyProfile });
  assert.ok(r.score < 60, `expected score < 60, got ${r.score}`);
}

// Test 8 — viral template patterns (2026 suppression structures)
{
  const post =
    'Here is what nobody tells you about selling.\n\n' +
    'Stop relying on referrals and start building inbound.\n\n' +
    'Body text develops the idea further with enough substance to meet minimum post requirements for the quality gate. ' .repeat(8) +
    'The result of this approach is measurable pipeline growth that compounds over time.\n\n' +
    'What shift are you making this quarter?\n\n' +
    '#sales #growth #b2b';
  const r = runQualityGate(post, { voiceProfile: emptyProfile });
  assert.ok(r.flags.includes('VIRAL_TEMPLATE'), `expected VIRAL_TEMPLATE flag, got ${r.flags}`);
}

console.log('qualityGate.test.js: all 8 tests passed');

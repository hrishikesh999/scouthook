'use strict';

// Pure unit tests for the input router — no DB, no network.
const { classifyInputMaturity, shouldOrganize, countWords, countSentences } = require('../../services/inputMaturity');

const AUTHORED_POST = `I lost our biggest client in March.

They left for an agency charging half what we did.

For weeks I told myself it was a price problem. It was not.

When I finally called their CMO, she said something I have not been able to shake.
She said she never once knew whether our work was doing anything.

We had been sending beautiful decks nobody opened.

So we scrapped the deck and replaced it with a five minute Loom every Friday.
Nothing fancy. Just me, the numbers, and what we were changing next.

Six months later churn is down and two of those clients have sent us referrals.

The work had not changed at all. Only whether they could see it.`;

const BULLETS = `
- lost our biggest client in March, they left for a cheaper agency
- turned out the real reason was we never showed them the reporting
- rebuilt onboarding around a weekly loom video instead of a deck
- churn dropped and two of them referred us afterwards
`;

describe('inputMaturity — seed tier (blank-page case still reaches the writer)', () => {
  test.each([
    ['', 'empty'],
    ['   \n  ', 'whitespace'],
    ['lessons from my first hire', 'short phrase'],
    ['why most SaaS onboarding fails and what to do about it', 'headline-length seed'],
  ])('classifies %j as seed (%s)', (input) => {
    expect(classifyInputMaturity(input).tier).toBe('seed');
  });

  test('shouldOrganize is false for a seed', () => {
    expect(shouldOrganize('a quick thought about pricing')).toBe(false);
  });
});

describe('inputMaturity — raw tier (spoken/bulleted material is organised, not composed)', () => {
  test('bulleted notes classify as raw', () => {
    const r = classifyInputMaturity(BULLETS);
    expect(r.tier).toBe('raw');
    expect(r.words).toBeGreaterThanOrEqual(40);
    expect(shouldOrganize(BULLETS)).toBe(true);
  });

  test('long text with no sentence structure is raw, not authored', () => {
    const runOn = Array.from({ length: 130 }, (_, i) => `word${i}`).join(' ');
    const r = classifyInputMaturity(runOn);
    expect(r.words).toBeGreaterThanOrEqual(120);
    expect(r.tier).toBe('raw');
  });
});

describe('inputMaturity — authored tier (a finished post must never be rewritten)', () => {
  test('a full written post classifies as authored', () => {
    const r = classifyInputMaturity(AUTHORED_POST);
    expect(r.tier).toBe('authored');
    expect(r.reason).toBe('long_multi_sentence');
    expect(shouldOrganize(AUTHORED_POST)).toBe(true);
  });
});

describe('inputMaturity — counting helpers', () => {
  test('line breaks count as sentence boundaries', () => {
    // LinkedIn drafts routinely omit terminal punctuation. Counting only ./!/?
    // would score a pasted post as a fragment and send it to the ghostwriter.
    const noPeriods = 'We shipped the redesign on Tuesday\nNobody noticed\nThat was the point\nGood infrastructure is invisible';
    expect(countSentences(noPeriods)).toBe(4);
  });

  test('one-word lines are not sentences', () => {
    expect(countSentences('yes\nno\nok')).toBe(0);
  });

  test('word counting ignores punctuation and bullets', () => {
    expect(countWords('- one, two; three!')).toBe(3);
    expect(countWords("don't stop")).toBe(2);
    expect(countWords('')).toBe(0);
    expect(countWords(null)).toBe(0);
  });
});

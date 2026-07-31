'use strict';

// Pure unit tests for the input router — no DB, no network.
const {
  classifyInputMaturity, shouldOrganize, isAuthoredDraft, countWords, countSentences,
} = require('../../services/inputMaturity');

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

describe('inputMaturity — regression: reflective post with no numbers', () => {
  // A real post that the content coach interrogated the author about. The old
  // client-side gate (isBriefRich) required a digit or a "last/this/past/next
  // week|month|year|quarter" phrase as proof of substance — a test built for
  // seeds. This post is finished and contains neither, so it fell through and
  // got coached. Maturity and specificity are different questions; pinning the
  // real text here so they do not get conflated again.
  const REFLECTIVE_POST = `I've been thinking about starting my publication for so long. For the most part of my career, people close to me always said something along these lines - "Rishi, you need to write."

But I've been putting it off.

Often times, I would start, get busy with setting up a fancy Wordpress site, write an article or two and then I am done.

When I sat down to reflect on this silent resistance, I realized a deeper truth.

It was the fear of being judged. Going one level deeper, it was - the fear of crticism.

That realization was confronting and empowering.

It gave me the courage to make a choice. Stay stuck in the fear or go beyond it.

Today, I am making a different choice.

The choice was always available. I just exercised it.

What different choice will you make today?`;

  test('classifies as authored despite containing no digits or dates', () => {
    expect(/\d/.test(REFLECTIVE_POST)).toBe(false);
    expect(classifyInputMaturity(REFLECTIVE_POST).tier).toBe('authored');
  });

  test('isAuthoredDraft is true, so the coach is skipped', () => {
    expect(isAuthoredDraft(REFLECTIVE_POST)).toBe(true);
  });
});

describe('inputMaturity — regression: short but dense post still coaches unnecessarily', () => {
  // A finished quote-plus-breakdown post: 95 words, 8 sentences, well under the
  // 120-word authored floor but unmistakably composed, not raw notes. It fell
  // through to 'raw' and the content coach interrogated the author about a post
  // they had already polished.
  const QUOTE_POST = `There are two kinds of people in this world: givers and takers.
The takers may eat better, but the givers sleep better." - Zig Ziglar

Here is how they differ:

Givers: Focused on value, service, and lifting others up. This underpins his ultimate philosophy: "You can have everything in life you want, if you will just help other people get what they want."

Takers: Focused on personal gain, consumption, and what they can acquire from a situation or relationship. While they might find short-term material comfort ("eat better"), they lack long-term peace of mind ("sleep better").`;

  test('classifies as authored despite being under the word floor', () => {
    const r = classifyInputMaturity(QUOTE_POST);
    expect(r.words).toBeLessThan(120);
    expect(r.tier).toBe('authored');
    expect(r.reason).toBe('dense_short_form');
  });

  test('isAuthoredDraft is true, so the coach is skipped', () => {
    expect(isAuthoredDraft(QUOTE_POST)).toBe(true);
  });
});

describe('inputMaturity — dense-short-form path does not swallow choppy raw notes', () => {
  test('bulleted notes stay raw even though they are made of short sentences', () => {
    expect(classifyInputMaturity(BULLETS).tier).toBe('raw');
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

'use strict';

const { runQualityGate } = require('../../services/qualityGate');

// 152-word body block used in tests that need a realistic, usable-length post.
const LONG_BODY = 'Building in public is one of the most underrated strategies for growing a consulting practice on LinkedIn. Most people share polished wins. The real leverage comes from sharing the messy middle, the pivots, the client conversations that changed your thinking, the frameworks that failed before they worked. When you share that, three things happen. First, readers trust you more because you sound human. Second, you attract clients who already understand your process. Third, you build a body of proof that no case study can match. The irony is that the imperfect posts often outperform the polished ones. Not because LinkedIn rewards vulnerability for its own sake, but because specificity beats abstraction every time. Concrete details convert readers into leads. Vague inspiration converts no one. Pick one moment from your week that taught you something real and write two hundred words about exactly what happened and why it changed how you work.';

describe('Quality Gate — TOO_SHORT (usability, not a length opinion)', () => {
  test('fails for a post under 20 words', () => {
    const r = runQualityGate('Too short.', {});
    expect(r.passed).toBe(false);
    expect(r.flags).toContain('TOO_SHORT');
  });

  test('a 20–149 word post is NOT flagged (graduated length grading was removed)', () => {
    const post = 'Short hook for this post.\n\n' + 'word '.repeat(80);
    const r = runQualityGate(post, {});
    expect(r.flags).not.toContain('TOO_SHORT');
    expect(r.passed).toBe(true);
  });

  test('passes for a normal-length post', () => {
    const r = runQualityGate('Strong hook.\n\n' + LONG_BODY, {});
    expect(r.passed).toBe(true);
    expect(r.flags).not.toContain('TOO_SHORT');
  });
});

describe('Quality Gate — AI_LANGUAGE_DETECTED (leaked assistant text only)', () => {
  test('flags "as an ai" and fails the gate', () => {
    const r = runQualityGate('As an AI language model I will explain this.\n\n' + LONG_BODY, {});
    expect(r.passed).toBe(false);
    expect(r.flags).toContain('AI_LANGUAGE_DETECTED');
  });

  test('flags "i hope this helps"', () => {
    const r = runQualityGate('Strong hook.\n\n' + LONG_BODY + '\n\nI hope this helps you out.', {});
    expect(r.flags).toContain('AI_LANGUAGE_DETECTED');
  });

  test('no longer flags taste clichés like "in conclusion" / "to summarize"', () => {
    const r1 = runQualityGate('Strong hook.\n\n' + LONG_BODY + '\n\nIn conclusion, this matters.', {});
    const r2 = runQualityGate('Strong hook.\n\n' + LONG_BODY + '\n\nTo summarize: do better work.', {});
    expect(r1.flags).not.toContain('AI_LANGUAGE_DETECTED');
    expect(r2.flags).not.toContain('AI_LANGUAGE_DETECTED');
  });
});

describe('Quality Gate — ENGAGEMENT_BAIT', () => {
  test('fails for "comment yes"', () => {
    const r = runQualityGate('Strong hook.\n\n' + LONG_BODY + '\n\nComment YES if you agree.', {});
    expect(r.passed).toBe(false);
    expect(r.flags).toContain('ENGAGEMENT_BAIT');
  });

  test('fails for "tag someone"', () => {
    const r = runQualityGate('Strong hook.\n\n' + LONG_BODY + '\n\nTag someone who needs this.', {});
    expect(r.passed).toBe(false);
    expect(r.flags).toContain('ENGAGEMENT_BAIT');
  });
});

describe('Quality Gate — taste checks are gone', () => {
  const withTail = (tail) => runQualityGate('Strong hook.\n\n' + LONG_BODY + '\n\n' + tail, {});

  test('no cliché flag', () => {
    // "game-changer" / "at the end of the day" used to trip CLICHE_DETECTED.
    expect(withTail('At the end of the day this is a game-changer.').flags).not.toContain('CLICHE_DETECTED');
  });

  test('no viral-template flag ("stop X, start Y")', () => {
    expect(withTail('Stop chasing reach, start building trust.').flags).not.toContain('VIRAL_TEMPLATE');
  });

  test('no hook-length / weak-opener flag for a long or "I am"-style opener', () => {
    const r = runQualityGate('I am going to walk you through the single most important thing about email lists today.\n\n' + LONG_BODY, {});
    expect(r.flags).not.toContain('HOOK_TOO_LONG');
    expect(r.flags).not.toContain('WEAK_HOOK_OPENER');
  });

  test('no NO_CTA flag when the post lacks a closing question', () => {
    expect(withTail('That is the whole point.').flags).not.toContain('NO_CTA');
  });

  test('no hashtag-spam flag (generation no longer emits hashtags)', () => {
    expect(withTail('#one #two #three #four #five').flags).not.toContain('HASHTAG_SPAM');
  });
});

describe('Quality Gate — clean pass has no opinion', () => {
  test('a normal post scores 100, passes, no flags, and a null verdict', () => {
    const r = runQualityGate('Strong hook that stops the scroll.\n\n' + LONG_BODY, {});
    expect(r.passed).toBe(true);
    expect(r.score).toBe(100);
    expect(r.flags).toHaveLength(0);
    expect(r.verdict).toBeNull();
  });
});

describe('Quality Gate — score reflects only objective problems', () => {
  test('leaked AI phrasing deducts from score', () => {
    const r = runQualityGate('Strong hook.\n\n' + LONG_BODY + '\n\nAs an AI, here is the summary.', {});
    expect(r.score).toBeLessThan(100);
  });
});

describe('Quality Gate — FABRICATED_SPECIFIC (provenance)', () => {
  test('flags a percentage that is not in the author\'s real input', () => {
    const post = 'Nurture beats broadcast.\n\n' + LONG_BODY + '\n\nRevenue grew 20% in 3 months.';
    const r = runQualityGate(post, { authorRealText: 'I helped a client nurture their list instead of only launching' });
    expect(r.flags).toContain('FABRICATED_SPECIFIC');
    expect(r.matches.FABRICATED_SPECIFIC).toEqual(expect.arrayContaining(['20%']));
    expect(r.dimensions.substance).toBeLessThan(100);
  });

  test('does NOT flag numbers the author actually supplied (digits or words)', () => {
    const post = 'Nurture beats broadcast.\n\n' + LONG_BODY + '\n\nRevenue grew 20% in three months.';
    const r = runQualityGate(post, { authorRealText: 'my client grew revenue 20 percent over three months after we fixed the nurture sequence' });
    expect(r.flags).not.toContain('FABRICATED_SPECIFIC');
  });

  test('does NOT flag list counts or niche idioms (6 figures, 3 steps)', () => {
    const post = 'Here is the play.\n\n' + LONG_BODY + '\n\nMost 6 figure creators miss this in 3 steps.';
    const r = runQualityGate(post, { authorRealText: 'creators stuck at six figures have a monetisation gap' });
    expect(r.flags).not.toContain('FABRICATED_SPECIFIC');
  });

  test('is a warning, not a hard failure (post still passes)', () => {
    const post = 'Nurture beats broadcast.\n\n' + LONG_BODY + '\n\nRevenue grew 20% in 3 months.';
    const r = runQualityGate(post, { authorRealText: 'I helped a client nurture their list' });
    expect(r.flags).toContain('FABRICATED_SPECIFIC');
    expect(r.passed).toBe(true);
  });

  test('is skipped entirely when no authorRealText is supplied', () => {
    const post = 'Hook.\n\n' + LONG_BODY + '\n\nRevenue grew 20% in 3 months.';
    const r = runQualityGate(post, {});
    expect(r.flags).not.toContain('FABRICATED_SPECIFIC');
  });

  test('flags currency and multipliers absent from input', () => {
    const post = 'Hook.\n\n' + LONG_BODY + '\n\nWe added $50,000 and 3x the pipeline.';
    const r = runQualityGate(post, { authorRealText: 'we grew the business a lot last year' });
    expect(r.flags).toContain('FABRICATED_SPECIFIC');
    expect(r.matches.FABRICATED_SPECIFIC).toEqual(expect.arrayContaining(['$50,000', '3x']));
  });
});

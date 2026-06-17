'use strict';

const { runQualityGate } = require('../../services/qualityGate');

// 152-word body block used in tests that need to clear the TOO_SHORT threshold
const LONG_BODY = 'Building in public is one of the most underrated strategies for growing a consulting practice on LinkedIn. Most people share polished wins. The real leverage comes from sharing the messy middle — the pivots, the client conversations that changed your thinking, the frameworks that failed before they worked. When you share that, three things happen. First, readers trust you more because you sound human. Second, you attract clients who already understand your process. Third, you build a body of proof that no case study can match. The irony is that the imperfect posts often outperform the polished ones. Not because LinkedIn rewards vulnerability for its own sake, but because specificity beats abstraction every time. Concrete details convert readers into leads. Vague inspiration converts no one. Pick one moment from your week that taught you something real and write two hundred words about exactly what happened and why it changed how you work.';

describe('Quality Gate — TOO_SHORT detection', () => {
  test('fails for post under 20 words', () => {
    const r = runQualityGate('Too short.', {});
    expect(r.passed).toBe(false);
    expect(r.flags).toContain('TOO_SHORT');
  });

  test('fails (with warning) for post between 20 and 149 words', () => {
    const post = 'Short hook for this post.\n\n' + 'word '.repeat(80);
    const r = runQualityGate(post, {});
    expect(r.passed).toBe(false);
    expect(r.flags).toContain('TOO_SHORT');
  });

  test('passes for post at or above 150 words', () => {
    const r = runQualityGate('Strong hook.\n\n' + LONG_BODY + '\n\nWhat do you think?', {});
    expect(r.passed).toBe(true);
    expect(r.flags).not.toContain('TOO_SHORT');
  });
});

describe('Quality Gate — AI_LANGUAGE_DETECTED', () => {
  test('flags "as an ai" phrase and fails the gate', () => {
    const r = runQualityGate(
      'As an AI language model I will explain this concept.\n\n' + LONG_BODY,
      {}
    );
    expect(r.passed).toBe(false);
    expect(r.flags).toContain('AI_LANGUAGE_DETECTED');
  });

  test('flags "in conclusion" phrase', () => {
    const r = runQualityGate(
      'Strong hook that stops the scroll.\n\n' + LONG_BODY + '\n\nIn conclusion, this matters because it does.',
      {}
    );
    expect(r.passed).toBe(false);
    expect(r.flags).toContain('AI_LANGUAGE_DETECTED');
  });

  test('flags "to summarize" phrase', () => {
    const r = runQualityGate(
      'Strong hook.\n\n' + LONG_BODY + '\n\nTo summarize: do better work.',
      {}
    );
    expect(r.passed).toBe(false);
    expect(r.flags).toContain('AI_LANGUAGE_DETECTED');
  });
});

describe('Quality Gate — HASHTAG_SPAM', () => {
  test('fails for more than 3 hashtags', () => {
    const r = runQualityGate(
      'Strong hook.\n\n' + LONG_BODY + '\n\n#one #two #three #four',
      {}
    );
    expect(r.passed).toBe(false);
    expect(r.flags).toContain('HASHTAG_SPAM');
  });

  test('passes with exactly 3 hashtags', () => {
    const r = runQualityGate(
      'Strong hook.\n\n' + LONG_BODY + '\n\n#one #two #three',
      {}
    );
    expect(r.passed).toBe(true);
    expect(r.flags).not.toContain('HASHTAG_SPAM');
  });
});

describe('Quality Gate — ENGAGEMENT_BAIT', () => {
  test('fails for "comment yes" pattern', () => {
    const r = runQualityGate(
      'Strong hook.\n\n' + LONG_BODY + '\n\nComment YES if you agree.',
      {}
    );
    expect(r.passed).toBe(false);
    expect(r.flags).toContain('ENGAGEMENT_BAIT');
  });

  test('fails for "tag someone" pattern', () => {
    const r = runQualityGate(
      'Strong hook.\n\n' + LONG_BODY + '\n\nTag someone who needs to read this.',
      {}
    );
    expect(r.passed).toBe(false);
    expect(r.flags).toContain('ENGAGEMENT_BAIT');
  });
});

describe('Quality Gate — clean pass', () => {
  test('150+ word post with no issues scores 100 and passes', () => {
    const r = runQualityGate(
      'Strong hook that stops the scroll.\n\n' + LONG_BODY + '\n\nWhat has been your experience with this?',
      {}
    );
    expect(r.passed).toBe(true);
    expect(r.score).toBe(100);
    expect(r.flags).toHaveLength(0);
  });

  test('passed:true sets a positive verdict', () => {
    const r = runQualityGate(
      'Strong hook that stops the scroll.\n\n' + LONG_BODY + '\n\nWhat has been your experience with this?',
      {}
    );
    expect(r.passed).toBe(true);
    expect(r.verdict).toContain('hook');
  });
});

describe('Quality Gate — score calculation', () => {
  test('AI language deducts from score', () => {
    const r = runQualityGate(
      'Strong hook.\n\n' + LONG_BODY + '\n\nIn conclusion this is important.',
      {}
    );
    expect(r.score).toBeLessThan(100);
  });

  test('multiple hashtags beyond limit each deduct 10 points', () => {
    const r = runQualityGate(
      'Strong hook.\n\n' + LONG_BODY + '\n\n#one #two #three #four #five',
      {}
    );
    // 2 excess hashtags = -20 points from 100
    expect(r.score).toBeLessThanOrEqual(80);
  });
});

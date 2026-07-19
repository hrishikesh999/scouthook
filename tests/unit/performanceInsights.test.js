'use strict';

const { computeInsights, engagementScore } = require('../../services/performanceInsights');

function post(type, reactions, comments, tag) {
  return { post_type: type, reactions, comments, performance_tag: tag || null };
}

describe('performanceInsights — engagementScore', () => {
  test('weights comments 3x reactions', () => {
    expect(engagementScore({ reactions: 10, comments: 0 })).toBe(10);
    expect(engagementScore({ reactions: 10, comments: 5 })).toBe(25);
  });

  test('strong/weak tags shift the score band', () => {
    expect(engagementScore({ reactions: 10, comments: 0, performance_tag: 'strong' })).toBe(15);
    expect(engagementScore({ reactions: 10, comments: 0, performance_tag: 'weak' })).toBe(5);
  });

  test('falls back to likes when reactions is absent', () => {
    expect(engagementScore({ likes: 8, comments: 1 })).toBe(11);
  });
});

describe('performanceInsights — computeInsights guards', () => {
  test('insufficient when fewer than the minimum total posts', () => {
    const rows = [post('story', 10, 1), post('story', 8, 0)];
    expect(computeInsights(rows).insufficient_data).toBe(true);
  });

  test('insufficient when there are not two comparable buckets', () => {
    // 6 posts but all one type → only one bucket clears MIN_POSTS_BUCKET.
    const rows = Array.from({ length: 6 }, () => post('story', 10, 1));
    const out = computeInsights(rows);
    expect(out.insufficient_data).toBe(true);
    expect(out.reason).toBe('not_enough_comparable_buckets');
  });

  test('empty / junk input is insufficient, never throws', () => {
    expect(computeInsights([]).insufficient_data).toBe(true);
    expect(computeInsights(null).insufficient_data).toBe(true);
  });
});

describe('performanceInsights — computeInsights ranking', () => {
  test('surfaces the top vs lagging bucket with a ratio claim', () => {
    const rows = [
      // stories: high engagement
      post('story', 40, 10), post('story', 50, 12), post('story', 45, 8),
      // frameworks: low engagement
      post('framework', 5, 0), post('framework', 6, 1), post('framework', 4, 0),
    ];
    const out = computeInsights(rows);
    expect(out.insufficient_data).toBe(false);
    expect(out.topBucket.key).toBe('story');
    expect(out.laggingBucket.key).toBe('framework');
    expect(out.insights[0].text).toMatch(/story/);
    expect(out.insights[0].text).toMatch(/×/);
  });

  test('does not overclaim when buckets are close', () => {
    const rows = [
      post('story', 20, 2), post('story', 22, 2), post('story', 19, 3),
      post('framework', 18, 2), post('framework', 21, 2), post('framework', 20, 2),
    ];
    const out = computeInsights(rows);
    expect(out.insufficient_data).toBe(false);
    // Close buckets → the "strongest format" phrasing, not an inflated ratio.
    expect(out.insights[0].text).toMatch(/strongest format|about/);
  });
});

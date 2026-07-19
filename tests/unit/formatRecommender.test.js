'use strict';

const { recommendFormat } = require('../../services/formatRecommender');

describe('formatRecommender', () => {
  test('framework post → carousel', () => {
    const r = recommendFormat({ postType: 'framework', brief: 'my 5-step onboarding system' });
    expect(r.format).toBe('carousel');
    expect(r.reason).toMatch(/saved|saves/i);
  });

  test('list-shaped brief → carousel even without framework type', () => {
    const r = recommendFormat({ postType: 'trust', brief: '3 ways to cut churn: step 1 do this' });
    expect(r.format).toBe('carousel');
  });

  test('results with a strong number → text+visual metrics card', () => {
    const r = recommendFormat({ postType: 'results', brief: 'grew revenue 40% in one quarter' });
    expect(r.format).toBe('text+visual');
    expect(r.visualType).toBe('metrics_card');
  });

  test('results without a number → text', () => {
    const r = recommendFormat({ postType: 'results', brief: 'a client turned things around' });
    expect(r.format).toBe('text');
  });

  test('story → text', () => {
    const r = recommendFormat({ postType: 'story', brief: 'the day I almost quit' });
    expect(r.format).toBe('text');
    expect(r.visualType).toBeNull();
  });

  test('money figure in a plain brief → offers a metrics card', () => {
    const r = recommendFormat({ postType: 'pis', brief: 'we saved them $50,000 a year' });
    expect(r.format).toBe('text+visual');
    expect(r.visualType).toBe('metrics_card');
  });

  test('empty input never throws and defaults to text', () => {
    expect(recommendFormat()).toEqual(expect.objectContaining({ format: 'text' }));
    expect(recommendFormat({}).format).toBe('text');
  });
});

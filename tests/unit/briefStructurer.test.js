'use strict';

// Pure unit tests for the transcript-structuring parser — no DB, no network.
const { normaliseStructured } = require('../../services/briefStructurer');

describe('briefStructurer — normaliseStructured', () => {
  test('keeps a well-formed object and validates the post type', () => {
    const out = normaliseStructured(JSON.stringify({
      moment: 'A call last March', proof: '$40k in 6 weeks', tension: 'Everyone sends decks',
      audience_hook: 'B2B founders', suggested_post_type: 'results', leftover_facts: [],
    }));
    expect(out.moment).toBe('A call last March');
    expect(out.proof).toBe('$40k in 6 weeks');
    expect(out.suggested_post_type).toBe('results');
  });

  test('nulls an out-of-list post type', () => {
    const out = normaliseStructured(JSON.stringify({ suggested_post_type: 'viral_banger' }));
    expect(out.suggested_post_type).toBeNull();
  });

  test('leaves proof empty when the transcript had no numbers (no invention)', () => {
    // The model is instructed to return empty proof when nothing concrete was said.
    const out = normaliseStructured(JSON.stringify({
      moment: 'I finally posted after months', proof: '', tension: '', audience_hook: '',
      suggested_post_type: 'story', leftover_facts: [],
    }));
    expect(out.proof).toBe('');
    expect(out.moment).toContain('posted');
  });

  test('caps leftover_facts at 2 and drops trivial ones', () => {
    const out = normaliseStructured(JSON.stringify({
      leftover_facts: [
        { fact: 'Closed a retainer with a fintech client after one call', hook: 'One call closed a retainer' },
        { fact: 'Rebuilt onboarding and cut churn to half in a quarter', hook: 'Cut churn in half' },
        { fact: 'Hired two people last year', hook: 'grew the team' },
        { fact: 'short', hook: 'x' },
      ],
    }));
    expect(out.leftover_facts).toHaveLength(2);
    expect(out.leftover_facts[0].fact).toMatch(/retainer/);
  });

  test('returns all-empty defaults on unparseable input', () => {
    const out = normaliseStructured('not json at all');
    expect(out).toEqual({ moment: '', proof: '', tension: '', audience_hook: '', suggested_post_type: null, leftover_facts: [] });
  });

  test('extracts the JSON object even with surrounding prose', () => {
    const out = normaliseStructured('Here you go:\n{"moment":"the standup","suggested_post_type":"bts"}\nHope that helps');
    expect(out.moment).toBe('the standup');
    expect(out.suggested_post_type).toBe('bts');
  });
});

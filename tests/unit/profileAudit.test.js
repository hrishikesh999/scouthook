'use strict';

const { parseAudit } = require('../../services/profileAudit');

describe('profileAudit — parseAudit', () => {
  test('parses and clamps a well-formed audit', () => {
    const out = parseAudit(JSON.stringify({
      score: 72, verdict: 'Your headline says what you do, not who you help.',
      headline_rewrites: ['A', 'B'], about_suggestions: ['x', 'y'], next_step: 'DM me "audit".',
    }));
    expect(out.score).toBe(72);
    expect(out.headline_rewrites).toEqual(['A', 'B']);
    expect(out.next_step).toMatch(/DM/);
  });

  test('clamps score to 0–100 and rounds', () => {
    expect(parseAudit(JSON.stringify({ score: 140 })).score).toBe(100);
    expect(parseAudit(JSON.stringify({ score: -5 })).score).toBe(0);
    expect(parseAudit(JSON.stringify({ score: 63.6 })).score).toBe(64);
  });

  test('nulls a non-numeric score', () => {
    expect(parseAudit(JSON.stringify({ score: 'high' })).score).toBeNull();
  });

  test('caps list fields at 3 and drops non-strings', () => {
    const out = parseAudit(JSON.stringify({
      headline_rewrites: ['a', 'b', 'c', 'd', 5, null],
    }));
    expect(out.headline_rewrites).toEqual(['a', 'b', 'c']);
  });

  test('returns null on unparseable input', () => {
    expect(parseAudit('not json')).toBeNull();
    expect(parseAudit('')).toBeNull();
  });

  test('extracts JSON embedded in prose', () => {
    const out = parseAudit('Sure!\n{"score": 50, "verdict": "ok"}\nDone');
    expect(out.score).toBe(50);
    expect(out.verdict).toBe('ok');
  });
});

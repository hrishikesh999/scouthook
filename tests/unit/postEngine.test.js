'use strict';

// Phase 2 guardrails: the unified engine must assemble a system prompt that
// carries the authenticity core and drops the persona + hashtag mandate for
// every post type. buildSystemPrompt/buildUserPrompt are pure (no API/DB call),
// though requiring postEngine pulls db.js — runs under NODE_ENV=test.
const engine = require('../../services/postEngine');
const { RECIPES } = require('../../services/postRecipes');
const profile = require('../fixtures/voiceProfile');

const SLUGS = Object.keys(RECIPES);

describe('postEngine — system prompt guardrails (all 10 types)', () => {
  for (const slug of SLUGS) {
    const r = RECIPES[slug];
    describe(slug, () => {
      const sys = engine.buildSystemPrompt(r, profile, '');

      test('no "Justin Welsh" persona', () => {
        expect(sys).not.toMatch(/justin welsh/i);
      });
      test('no hashtag mandate, and hashtags explicitly forbidden', () => {
        expect(sys).not.toMatch(/include up to \d+ relevant hashtags|hashtags at the end of the post/i);
        expect(sys).toContain('Do not append hashtags');
      });
      test('carries the authenticity core', () => {
        expect(sys).toContain('WRITING PROHIBITIONS');
        expect(sys).toContain('SPECIFICITY RULE:');
      });
      test('carries shared author context + phrase library', () => {
        expect(sys).toContain('## AUTHOR CONTEXT');
        expect(sys).toContain('PHRASE LIBRARY');
      });
      test('carries its own structure guide', () => {
        expect(sys).toContain(r.structureGuide.split('\n')[0]);
      });
      test('craft rules present iff includeCraftRules', () => {
        expect(sys.includes('HOOK (first line')).toBe(r.includeCraftRules);
      });
      test('enumeration carve-out present iff allowEnumeration', () => {
        expect(sys.includes('STRUCTURE EXCEPTION')).toBe(r.allowEnumeration);
      });
      test('CTA-handling block present iff acceptsCtaIntent', () => {
        expect(sys.includes('CTA HANDLING:')).toBe(r.acceptsCtaIntent);
      });
    });
  }
});

describe('postEngine — user prompt assembly', () => {
  test('input label + length + CTA line for CTA-accepting types', () => {
    const up = engine.buildUserPrompt(RECIPES.trust, 'Email lists are underrated.', 'Long', 'Book a call');
    expect(up).toContain('WHAT TO TEACH OR CLARIFY:\nEmail lists are underrated.');
    expect(up).toContain('POST LENGTH: Long');
    expect(up).toContain('CTA INTENT: Book a call');
  });

  test('CTA intent collapses to "Nothing (no CTA)" when blank', () => {
    const up = engine.buildUserPrompt(RECIPES.results, 'Grew revenue.', 'Medium', '');
    expect(up).toContain('CTA INTENT: Nothing (no CTA)');
  });

  test('no CTA line at all for non-CTA types', () => {
    const up = engine.buildUserPrompt(RECIPES.pis, 'Nurture matters.', 'Medium', 'ignored');
    expect(up).not.toMatch(/CTA INTENT/);
    expect(up).toContain('POST CONTENT:\nNurture matters.');
  });

  test('label-less types put the raw idea first', () => {
    const up = engine.buildUserPrompt(RECIPES.story, 'I quit my job.', 'Short', '');
    expect(up.startsWith('I quit my job.')).toBe(true);
  });
});

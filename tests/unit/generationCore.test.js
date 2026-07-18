'use strict';

// Pure unit tests — no DB, no network. generationCore only requires postSanitiser.
const core = require('../../services/generationCore');
const profile = require('../fixtures/voiceProfile');

describe('generationCore — authenticity core', () => {
  test('buildAuthenticityCore contains every craft rule + prohibition + specificity mandate', () => {
    const out = core.buildAuthenticityCore();
    expect(out).toContain('HOOK (first line — non-negotiable):');
    expect(out).toContain('ABOVE THE FOLD:');
    expect(out).toContain('DEPTH:');
    expect(out).toContain('POINT OF VIEW (non-negotiable):');
    expect(out).toContain('LINKEDIN FORMATTING (non-negotiable):');
    expect(out).toContain('WRITING PROHIBITIONS');
    expect(out).toContain('SPECIFICITY RULE:');
  });

  test('self-check is opt-in', () => {
    expect(core.buildAuthenticityCore()).not.toContain('SELF-CHECK BEFORE OUTPUTTING');
    expect(core.buildAuthenticityCore({ includeSelfCheck: true })).toContain('SELF-CHECK BEFORE OUTPUTTING');
  });

  test('enumeration carve-out is opt-in (frameworks/checklists only)', () => {
    expect(core.buildAuthenticityCore()).not.toContain('STRUCTURE EXCEPTION (numbered lists)');
    const withEnum = core.buildAuthenticityCore({ allowEnumeration: true });
    expect(withEnum).toContain('STRUCTURE EXCEPTION (numbered lists)');
    // The carve-out must still coexist with the "no three parallel points" rule.
    expect(withEnum).toContain('three parallel points of equal length');
  });

  test('the consolidation goal: core carries NO Justin Welsh persona and NO hashtag mandate', () => {
    const out = core.buildAuthenticityCore({ allowEnumeration: true, includeSelfCheck: true });
    expect(out.toLowerCase()).not.toContain('justin welsh');
    expect(out).not.toMatch(/hashtags?/i);
  });

  test('carries the provenance rule', () => {
    const out = core.buildAuthenticityCore();
    expect(out).toContain('PROVENANCE (specifics must be real):');
    expect(out).toContain('[AI-SUGGESTED]');
  });
});

describe('generationCore — extractAuthorRealText', () => {
  test('strips [AI-SUGGESTED]…[/AI-SUGGESTED] blocks', () => {
    const raw = '[AI-SUGGESTED]\nEmail lists grew 20% in 3 months\n[/AI-SUGGESTED]\n\n[AUTHOR-REAL]\nQ: what happened\nA: I stopped launch-only emailing\n[/AUTHOR-REAL]';
    const real = core.extractAuthorRealText(raw);
    expect(real).not.toContain('20%');
    expect(real).not.toContain('3 months');
    expect(real).toContain('stopped launch-only emailing');
  });

  test('untagged input is all author-real', () => {
    expect(core.extractAuthorRealText('I grew a client 20% in 8 weeks')).toBe('I grew a client 20% in 8 weeks');
  });

  test('empty / nullish input', () => {
    expect(core.extractAuthorRealText('')).toBe('');
    expect(core.extractAuthorRealText(null)).toBe('');
  });
});

describe('generationCore — shared author context', () => {
  test('renders every profile section for a full fixture', () => {
    const out = core.buildSharedAuthorContext(profile);
    expect(out).toContain('## AUTHOR CONTEXT');
    expect(out).toContain('BRAND VOICE:');
    expect(out).toContain('- What they do: I help course creators');
    expect(out).toContain('- Personality: direct, contrarian, practical');
    expect(out).toContain('TARGET AUDIENCE:');
    expect(out).toContain('AUTHORITY PROOF (use only when it fits naturally — never force it):');
    expect(out).toContain('VOICE DNA (distilled voice signature');
  });

  test('audience resonance mandate precedes the data and instructs picking one dimension', () => {
    const out = core.buildSharedAuthorContext(profile);
    expect(out).toContain('AUDIENCE RESONANCE (non-negotiable):');
    expect(out).toContain('pick the ONE belief, desire, or problem');
    expect(out).toContain('Do NOT gesture at the whole list');
    const iMandate = out.indexOf('AUDIENCE RESONANCE (non-negotiable):');
    const iData = out.indexOf('TARGET AUDIENCE:');
    expect(iMandate).toBeGreaterThan(-1);
    expect(iData).toBeGreaterThan(iMandate);
  });

  test('resonance mandate is omitted when the profile has no audience fields', () => {
    const out = core.buildSharedAuthorContext({ brand_description: 'I help course creators' });
    expect(out).toContain('BRAND VOICE:');
    expect(out).not.toContain('AUDIENCE RESONANCE');
    expect(out).not.toContain('TARGET AUDIENCE:');
  });

  test('phrase library is included by default and omittable', () => {
    expect(core.buildSharedAuthorContext(profile)).toContain('PHRASE LIBRARY');
    expect(core.buildSharedAuthorContext(profile, { includePhraseLibrary: false }))
      .not.toContain('PHRASE LIBRARY');
  });

  test('phrase library keeps top-5 by specificity, most-specific first', () => {
    const out = core.buildSharedAuthorContext(profile);
    const iAsset = out.indexOf('the list is the asset');       // score 0.94
    const iRent  = out.indexOf('rented land versus owned');    // score 0.71
    expect(iAsset).toBeGreaterThan(-1);
    expect(iRent).toBeGreaterThan(iAsset);
  });

  test('degrades cleanly on an empty profile', () => {
    const out = core.buildSharedAuthorContext({});
    expect(out).toContain('## AUTHOR CONTEXT');
    expect(out).not.toContain('BRAND VOICE:');
    expect(out).not.toContain('PHRASE LIBRARY');
    expect(out).not.toContain('AUDIENCE RESONANCE');
  });

  test('tolerates malformed JSON fields without throwing', () => {
    expect(() => core.buildSharedAuthorContext({
      brand_personality_traits: '{not json',
      writing_sample_phrases: 'also not json',
      authority_statements: null,
    })).not.toThrow();
  });
});

describe('generationCore — assembleBrief (interview provenance)', () => {
  test('labels the seed idea as the author\'s words', () => {
    const out = core.assembleBrief({ initialInput: 'I lost a deal by over-preparing', exchanges: [] });
    expect(out).toContain("RAW IDEA (author's words):");
    expect(out).toContain('I lost a deal by over-preparing');
  });

  test('maps each gap to its human-readable slot label', () => {
    const out = core.assembleBrief({
      initialInput: 'seed',
      exchanges: [
        { question: 'What happened?', answer: 'A call last March', gap: 'moment' },
        { question: 'Numbers?',        answer: '$40k in 6 weeks',  gap: 'proof' },
        { question: 'The twist?',      answer: 'Everyone sends decks; I sent one line', gap: 'tension' },
        { question: 'Who for?',        answer: 'B2B founders',      gap: 'audience' },
      ],
    });
    expect(out).toContain("THE MOMENT (author's words):");
    expect(out).toContain("PROOF / NUMBERS (author's words):");
    expect(out).toContain("THE TENSION (author's words):");
    expect(out).toContain("WHO THIS IS FOR (author's words):");
    expect(out).toContain('$40k in 6 weeks');
  });

  test('wraps accepted skip-suggestions in [AI-SUGGESTED] and keeps them out of author-real text', () => {
    const out = core.assembleBrief({
      initialInput: 'My real seed',
      exchanges: [
        { question: 'Numbers?', answer: 'maybe around 3x growth', gap: 'proof', from_skip_suggestion: true },
        { question: 'Moment?',  answer: 'The Tuesday standup',    gap: 'moment' },
      ],
    });
    expect(out).toContain('[AI-SUGGESTED]');
    expect(out).toContain('[/AI-SUGGESTED]');
    // The AI-suggested figure must be stripped from what the quality gate treats as real.
    const real = core.extractAuthorRealText(out);
    expect(real).not.toContain('3x growth');
    // The author's own answer survives.
    expect(real).toContain('The Tuesday standup');
    expect(real).toContain('My real seed');
  });

  test('falls back to a plain Q/A pair when gap is unknown', () => {
    const out = core.assembleBrief({
      initialInput: '',
      exchanges: [{ question: 'Anything else?', answer: 'Just a hunch', gap: 'other' }],
    });
    expect(out).toContain('Q: Anything else?');
    expect(out).toContain("A (author's words): Just a hunch");
  });

  test('omits empty answers and tolerates missing fields', () => {
    const out = core.assembleBrief({
      initialInput: 'seed',
      exchanges: [
        { question: 'Q1', answer: '   ', gap: 'moment' },
        { answer: 'no question here' },
        null,
        { question: 'Q2' },
      ],
    });
    expect(out).toContain('seed');
    expect(out).toContain('no question here');
    expect(out).not.toContain('Q1');
    expect(out).not.toContain('Q2');
  });

  test('returns empty string for empty input', () => {
    expect(core.assembleBrief({})).toBe('');
    expect(core.assembleBrief()).toBe('');
  });
});

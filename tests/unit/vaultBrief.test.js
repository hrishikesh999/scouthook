'use strict';

// Pure unit tests for the vault role-brief builder — no DB, no network.
const {
  buildRoleBrief, ROLE_ORDER, MAX_PASSAGE_CHARS,
} = require('../../services/vaultBrief');

const SPINE = {
  role: 'spine',
  content: 'Legacy terminal systems fail at integration, not at capacity.',
  passage: 'Across eleven terminal modernisations we found the same thing. The hardware was rarely the constraint. What broke was the handoff between systems that were never designed to talk to each other.',
  chunkId: 11,
  sourceRef: 'p. 4',
};
const TENSION = {
  role: 'tension',
  content: 'Everyone assumes modernisation means replacing the system.',
  passage: 'Operators arrive expecting a rip-and-replace programme, because that is what vendors sell them.',
  chunkId: 12,
};
const PROOF = {
  role: 'proof',
  content: 'Yard throughput rose 23% in eleven weeks without adding a crane.',
  passage: 'At London Gateway, yard throughput rose 23% within eleven weeks of cutover. No additional cranes were commissioned.',
  chunkId: 13,
};

describe('buildRoleBrief', () => {
  test('requires a spine', () => {
    expect(() => buildRoleBrief({ blocks: [TENSION, PROOF] }))
      .toThrow(/no spine/);
    expect(() => buildRoleBrief({ blocks: [] })).toThrow(/no spine/);
  });

  test('does NOT claim the document is the author\'s own words', () => {
    const brief = buildRoleBrief({ filename: 'lg.pdf', blocks: [SPINE, PROOF] });
    // The regression this guards: the shipped insight path says "The author's own
    // words, from their document", which is false for marketing-written material.
    expect(brief).not.toMatch(/in their own words/i);
    expect(brief).not.toMatch(/author's own words/i);
    expect(brief).toMatch(/not necessarily the author's writing/i);
  });

  test('separates binding facts from non-binding phrasing', () => {
    const brief = buildRoleBrief({ blocks: [SPINE] });
    expect(brief).toMatch(/WHAT IS BINDING/);
    expect(brief).toMatch(/WHAT IS NOT BINDING/);
    expect(brief).toMatch(/Do not preserve corporate, formal or marketing wording/i);
  });

  test('orders blocks canonically regardless of input order', () => {
    const brief = buildRoleBrief({ blocks: [PROOF, TENSION, SPINE] });
    const iSpine   = brief.indexOf('SPINE —');
    const iTension = brief.indexOf('TENSION —');
    const iProof   = brief.indexOf('PROOF —');
    expect(iSpine).toBeGreaterThan(-1);
    expect(iSpine).toBeLessThan(iTension);
    expect(iTension).toBeLessThan(iProof);
  });

  test('includes both the insight line and its source passage', () => {
    const brief = buildRoleBrief({ blocks: [SPINE] });
    expect(brief).toContain(SPINE.content);          // the pointer
    expect(brief).toContain('The hardware was rarely the constraint'); // the material
  });

  test('marks an unresolved passage as condensed rather than passing paraphrase as source', () => {
    const brief = buildRoleBrief({
      blocks: [SPINE, { role: 'tension', content: 'Modernisation means replacement.' }],
    });
    expect(brief).toMatch(/no source passage resolved/i);
    expect(brief).toMatch(/wording as ours/i);
  });

  test('prints a shared passage once and cross-references it', () => {
    const shared = { ...PROOF, chunkId: 11 }; // same chunk as the spine
    const brief = buildRoleBrief({ blocks: [SPINE, shared] });
    const occurrences = brief.split(SPINE.passage).length - 1;
    expect(occurrences).toBe(1);
    expect(brief).toMatch(/from the same passage as SPINE, above/);
  });

  test('dedupes on passage text when chunkId is absent', () => {
    const a = { role: 'spine',   content: 'Claim.',   passage: 'Identical prose here, long enough to key on.' };
    const b = { role: 'tension', content: 'Counter.', passage: 'Identical prose here, long enough to key on.' };
    const brief = buildRoleBrief({ blocks: [a, b] });
    expect(brief.split('Identical prose here').length - 1).toBe(1);
  });

  test('clamps an overlong passage and marks the truncation', () => {
    const long = { role: 'spine', content: 'Claim.', passage: 'sentence text. '.repeat(400) };
    const brief = buildRoleBrief({ blocks: [long] });
    expect(brief).toContain('[…]');
    expect(brief.length).toBeLessThan(MAX_PASSAGE_CHARS + 2000);
  });

  test('drops unknown roles and empty content instead of emitting blank blocks', () => {
    const brief = buildRoleBrief({
      blocks: [SPINE, { role: 'vibes', content: 'x' }, { role: 'proof', content: '   ' }],
    });
    expect(brief).not.toMatch(/vibes/i);
    expect(brief).not.toMatch(/PROOF —/);
  });

  test('labels neighbour context as background, not subject', () => {
    const brief = buildRoleBrief({ blocks: [SPINE], neighbours: 'Earlier in the report.' });
    expect(brief).toMatch(/background only, not the subject of the post/i);
  });

  test('omits the neighbour section when there is none', () => {
    expect(buildRoleBrief({ blocks: [SPINE] })).not.toMatch(/SURROUNDING CONTEXT/);
  });

  test('tells the model not to echo the labels', () => {
    expect(buildRoleBrief({ blocks: [SPINE] })).toMatch(/Never echo a label/i);
  });

  test('ROLE_ORDER starts with spine', () => {
    expect(ROLE_ORDER[0]).toBe('spine');
  });
});

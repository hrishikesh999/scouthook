'use strict';

// Pure unit tests for the verbatim-span filter — no DB, no network.
const { filterValidSpans } = require('../../services/makeItYours');

const POST = `I lost a $40k deal by over-preparing.

Everyone told me to send a deck. I sent one line instead.

Stop preparing for the client you think you have.`;

describe('makeItYours — filterValidSpans', () => {
  test('keeps spans whose excerpt appears verbatim', () => {
    const spans = filterValidSpans([
      { excerpt: 'I lost a $40k deal by over-preparing.', slot: 'hook', why: 'w', prompt: 'p' },
    ], POST);
    expect(spans).toHaveLength(1);
    expect(spans[0].slot).toBe('hook');
  });

  test('drops paraphrased excerpts that are not in the post', () => {
    const spans = filterValidSpans([
      { excerpt: 'I lost a forty thousand dollar deal', slot: 'hook' },
    ], POST);
    expect(spans).toHaveLength(0);
  });

  test('normalises an invalid slot to bridge and supplies a default prompt', () => {
    const spans = filterValidSpans([
      { excerpt: 'I sent one line instead.', slot: 'nonsense' },
    ], POST);
    expect(spans[0].slot).toBe('bridge');
    expect(spans[0].prompt).toBeTruthy();
  });

  test('dedupes identical excerpts', () => {
    const spans = filterValidSpans([
      { excerpt: 'I sent one line instead.', slot: 'punchline' },
      { excerpt: 'I sent one line instead.', slot: 'bridge' },
    ], POST);
    expect(spans).toHaveLength(1);
  });

  test('caps at 3 spans', () => {
    const parsed = [
      { excerpt: 'I lost a $40k deal by over-preparing.' },
      { excerpt: 'Everyone told me to send a deck.' },
      { excerpt: 'I sent one line instead.' },
      { excerpt: 'Stop preparing for the client you think you have.' },
    ];
    expect(filterValidSpans(parsed, POST)).toHaveLength(3);
  });

  test('tolerates junk input without throwing', () => {
    expect(filterValidSpans(null, POST)).toEqual([]);
    expect(filterValidSpans([null, 42, {}, { excerpt: 5 }], POST)).toEqual([]);
    expect(filterValidSpans([{ excerpt: 'x' }], '')).toEqual([]);
  });
});

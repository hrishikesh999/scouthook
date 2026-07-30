'use strict';

// Pure unit tests for angle validation — no DB, no network.
// This is the layer that has to survive a model returning plausible nonsense.
const { validateAngle, formatInsights, MAX_ANGLES } = require('../../services/vaultAngles');

const VALID = new Set([1, 2, 3, 4, 5]);
const fresh = () => new Set();

const angle = (over = {}) => ({
  title: 'Legacy systems fail at integration, not capacity',
  spine: 1, tension: 2, proof: 3, mechanism: null, consequence: null,
  ...over,
});

describe('validateAngle', () => {
  test('accepts a well-formed angle and flattens its ids', () => {
    const a = validateAngle(angle(), VALID, fresh());
    expect(a.roles).toEqual({ spine: 1, tension: 2, proof: 3 });
    expect(a.insightIds.sort()).toEqual([1, 2, 3]);
  });

  test('drops the angle when the spine id was hallucinated', () => {
    expect(validateAngle(angle({ spine: 99 }), VALID, fresh())).toBeNull();
  });

  test('drops a bad support id but keeps the angle', () => {
    const a = validateAngle(angle({ proof: 99 }), VALID, fresh());
    expect(a).not.toBeNull();
    expect(a.roles).toEqual({ spine: 1, tension: 2 });
  });

  test('rejects a reused spine — same claim is the same post', () => {
    const used = fresh();
    expect(validateAngle(angle({ spine: 1 }), VALID, used)).not.toBeNull();
    used.add(1);
    expect(validateAngle(angle({ spine: 1, tension: 4 }), VALID, used)).toBeNull();
  });

  test('allows a support to be reused across angles', () => {
    // Rule 3: one strong number can prove two different claims. Reuse is tracked
    // for spines only, so a shared support must survive.
    const used = fresh();
    const first = validateAngle(angle({ spine: 1, proof: 3 }), VALID, used);
    used.add(first.roles.spine);
    const second = validateAngle(angle({ spine: 2, tension: 4, proof: 3 }), VALID, used);
    expect(second.roles.proof).toBe(3);
  });

  test('rejects spine-only — that is just the single-insight path', () => {
    expect(validateAngle(
      angle({ tension: null, proof: null, mechanism: null, consequence: null }),
      VALID, fresh(),
    )).toBeNull();
  });

  test('accepts a spine plus exactly one support', () => {
    const a = validateAngle(angle({ tension: null, proof: 3 }), VALID, fresh());
    expect(a.roles).toEqual({ spine: 1, proof: 3 });
  });

  test('ignores a support that duplicates the spine', () => {
    const a = validateAngle(angle({ tension: 1, proof: 3 }), VALID, fresh());
    expect(a.roles).toEqual({ spine: 1, proof: 3 });
    expect(a.insightIds).not.toContain(undefined);
  });

  test('requires a title', () => {
    expect(validateAngle(angle({ title: '   ' }), VALID, fresh())).toBeNull();
    expect(validateAngle(angle({ title: undefined }), VALID, fresh())).toBeNull();
  });

  test('caps title length', () => {
    const a = validateAngle(angle({ title: 'x'.repeat(500) }), VALID, fresh());
    expect(a.title.length).toBe(300);
  });

  test('survives junk input without throwing', () => {
    for (const junk of [null, undefined, {}, { title: 'x' }, { spine: 'abc', title: 'x' }, []]) {
      expect(() => validateAngle(junk, VALID, fresh())).not.toThrow();
      expect(validateAngle(junk, VALID, fresh())).toBeNull();
    }
  });

  test('tolerates string ids from a loosely-typed model response', () => {
    const a = validateAngle(angle({ spine: '1', proof: '3' }), VALID, fresh());
    expect(a.roles.spine).toBe(1);
    expect(a.roles.proof).toBe(3);
  });
});

describe('formatInsights', () => {
  test('labels every insight with its real id and category', () => {
    const out = formatInsights([
      { id: 7, category: 'key_insight', content: 'Integration is the constraint.', source_ref: 'p. 4' },
      { id: 8, category: 'quote', content: 'You cannot automate what nobody wrote down.', source_ref: null },
    ]);
    expect(out).toContain('[id 7] (key_insight, p. 4) Integration is the constraint.');
    expect(out).toContain('[id 8] (quote) You cannot automate what nobody wrote down.');
  });
});

describe('caps', () => {
  test('MAX_ANGLES is a small product cap, not a material one', () => {
    expect(MAX_ANGLES).toBeLessThanOrEqual(4);
  });
});

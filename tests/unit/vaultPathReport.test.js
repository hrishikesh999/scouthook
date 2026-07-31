'use strict';

// Pure unit tests for the vault-path report arithmetic — no DB, no network.
const { aggregatePosts, median, VAULT_SOURCES } = require('../../services/vaultPathReport');

const DRAFT = 'Legacy terminal systems fail at integration not at capacity. Yard throughput rose 23 percent in eleven weeks at London Gateway.';
const PUBLISHED_ASIS = DRAFT;
const PUBLISHED_REWRITTEN = 'Completely different sentence about unrelated marketing funnels and email nurture sequences everywhere.';

const post = (over = {}) => ({
  source: 'vault_angle', status: 'draft', quality_score: 100,
  ai_content: DRAFT, content: DRAFT, ...over,
});
const row = (rows, source) => rows.find(r => r.source === source);

describe('median', () => {
  test('odd and even lengths', () => {
    expect(median([1, 5, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  test('empty is null, not zero — no data must not read as a bad score', () => {
    expect(median([])).toBeNull();
  });
});

describe('aggregatePosts', () => {
  test('always emits every vault path plus the baseline, even with no data', () => {
    const rows = aggregatePosts([]);
    for (const s of VAULT_SOURCES) expect(row(rows, s)).toBeTruthy();
    expect(row(rows, 'other')).toBeTruthy();
    expect(row(rows, 'vault_angle').generated).toBe(0);
    expect(row(rows, 'vault_angle').publish_rate).toBeNull();
  });

  test('counts generated and published per path', () => {
    const rows = aggregatePosts([
      post(), post(), post({ status: 'published' }),
      post({ source: 'vault_insight', status: 'published' }),
    ]);
    expect(row(rows, 'vault_angle').generated).toBe(3);
    expect(row(rows, 'vault_angle').published).toBe(1);
    expect(row(rows, 'vault_angle').publish_rate).toBeCloseTo(33.3, 1);
    expect(row(rows, 'vault_insight').publish_rate).toBe(100);
  });

  test('unknown sources collapse into the baseline bucket', () => {
    const rows = aggregatePosts([post({ source: 'idea_card' }), post({ source: null })]);
    expect(row(rows, 'other').generated).toBe(2);
  });

  test('a published post kept verbatim scores near 1', () => {
    const rows = aggregatePosts([post({ status: 'published', content: PUBLISHED_ASIS })]);
    expect(row(rows, 'vault_angle').median_kept).toBeGreaterThan(0.95);
  });

  test('a heavily rewritten post scores low — this is the verdict metric', () => {
    const rows = aggregatePosts([post({ status: 'published', content: PUBLISHED_REWRITTEN })]);
    expect(row(rows, 'vault_angle').median_kept).toBeLessThan(0.2);
  });

  test('drafts are never scored for kept — only published posts count', () => {
    const rows = aggregatePosts([post({ status: 'draft', content: PUBLISHED_REWRITTEN })]);
    expect(row(rows, 'vault_angle').kept_n).toBe(0);
    expect(row(rows, 'vault_angle').median_kept).toBeNull();
  });

  test('a published post with no ai_content is excluded rather than scored as perfect', () => {
    // Legacy rows predate the ai_content column. Treating a missing draft as
    // "100% kept" would silently inflate every older path.
    const rows = aggregatePosts([
      post({ status: 'published', ai_content: null }),
      post({ status: 'published', content: PUBLISHED_ASIS }),
    ]);
    expect(row(rows, 'vault_angle').published).toBe(2);
    expect(row(rows, 'vault_angle').kept_n).toBe(1);
  });

  test('separates a direct angle click from an insight-upgraded one', () => {
    const rows = aggregatePosts([
      post({ source: 'vault_angle', status: 'published' }),
      post({ source: 'vault_angle_via_insight' }),
    ]);
    expect(row(rows, 'vault_angle').generated).toBe(1);
    expect(row(rows, 'vault_angle_via_insight').generated).toBe(1);
    expect(row(rows, 'vault_angle_via_insight').published).toBe(0);
  });

  test('unedited_rate separates verbatim publishing from light editing', () => {
    // The reason this exists: retentionScore floors out. On prod, 19 of 36
    // published posts scored exactly 1.0 — 13 byte-identical and 6 edited too
    // lightly to register — so the median said nothing useful.
    const lightlyEdited = DRAFT.replace('Legacy terminal systems', 'Legacy terminal systems, it turns out,');
    const rows = aggregatePosts([
      post({ status: 'published', content: DRAFT }),          // verbatim
      post({ status: 'published', content: lightlyEdited }),  // touched
    ]);
    const r = row(rows, 'vault_angle');
    expect(r.unedited_rate).toBe(50);
    expect(r.median_kept).toBeGreaterThan(0.9);   // both still score high...
    expect(r.unedited_rate).toBeLessThan(100);    // ...but this catches the edit
  });

  test('unedited_rate is null with nothing published, not 0', () => {
    expect(row(aggregatePosts([post()]), 'vault_angle').unedited_rate).toBeNull();
  });

  test('median gate ignores posts with no score', () => {
    const rows = aggregatePosts([post({ quality_score: 80 }), post({ quality_score: null }), post({ quality_score: 100 })]);
    expect(row(rows, 'vault_angle').median_gate).toBe(90);
  });
});

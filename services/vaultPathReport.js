'use strict';

/**
 * services/vaultPathReport.js — did bundling insights into angles actually help?
 *
 * Phase 5 of sprint-vault-angles.md. The sprint rests on one unproven claim: that
 * a post synthesised from a claim-plus-evidence angle is better than one written
 * from a single insight. Every measurement so far (retention, gate score) says the
 * mechanism works as specified, and none of them says users prefer the output.
 *
 * Two comparisons settle it, and both are computable from data already stored:
 *
 * 1. PUBLISH RATE per path. generated_posts.source distinguishes the three vault
 *    paths. If people publish angle posts more often than insight posts, the
 *    bundling earns its place.
 *
 * 2. HOW MUCH OF THE DRAFT SURVIVED. ai_content holds the original generation and
 *    is never overwritten; content holds what the user actually published. So
 *    retentionScore(ai_content, content) is the fraction of the PUBLISHED post's
 *    words that came from the draft — high means they published close to what we
 *    wrote, low means they rewrote it. This is the honest verdict: a path can
 *    convert well and still be producing drafts people have to repair.
 *
 * Reusing retentionScore rather than raw Levenshtein is deliberate — it is
 * stopword-filtered and lightly stemmed, so reformatting and pluralisation do not
 * register as rewriting, and the numbers are directly comparable to the retention
 * figures already logged at generation time.
 */

const { retentionScore } = require('./retention');

// The paths worth separating. Everything else collapses into a baseline so the
// vault numbers can be read against the product's normal behaviour rather than
// in isolation — "62% published" means nothing without knowing the house average.
const VAULT_SOURCES = ['vault_angle', 'vault_angle_via_insight', 'vault_insight'];

const LABELS = {
  vault_angle:            'Angle (clicked directly)',
  vault_angle_via_insight:'Angle (upgraded from insight)',
  vault_insight:          'Single insight',
  other:                  'All other paths (baseline)',
};

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 100) / 100;
}

/**
 * @param {object}  [opts]
 * @param {string}  [opts.tenantId]  limit to one workspace; omit for all
 * @param {number}  [opts.days]      lookback window, default 90
 * @returns {Promise<{ generated_since: string, rows: Array }>}
 */
async function buildVaultPathReport({ tenantId = null, days = 90 } = {}) {
  const { db } = require('../db');

  const params = [days];
  let scope = '';
  if (tenantId) { scope = ' AND tenant_id = ?'; params.push(tenantId); }

  const posts = await db.prepare(`
    SELECT source, status, quality_score, passed_gate, ai_content, content, published_at
    FROM   generated_posts
    WHERE  created_at > now() - (? || ' days')::interval${scope}
  `).all(...params);

  return { window_days: days, total_posts: posts.length, rows: aggregatePosts(posts) };
}

/**
 * Pure aggregation, split out so the arithmetic that decides whether this sprint
 * worked can be tested without a database.
 * @param {Array<{source,status,quality_score,ai_content,content}>} posts
 */
function aggregatePosts(posts) {
  const buckets = new Map();
  const bucketOf = (src) => (VAULT_SOURCES.includes(src) ? src : 'other');
  for (const key of [...VAULT_SOURCES, 'other']) {
    buckets.set(key, { generated: 0, published: 0, kept: [], gate: [], unedited: 0 });
  }

  for (const p of posts) {
    const b = buckets.get(bucketOf(p.source));
    b.generated++;
    if (typeof p.quality_score === 'number') b.gate.push(p.quality_score);
    if (p.status !== 'published') continue;
    b.published++;
    // A published post with no ai_content predates the column, or was written by
    // hand. Either way there is no draft to compare against, so it must not be
    // scored as 100% kept — that would silently inflate every legacy path.
    if (p.ai_content && p.content) {
      b.kept.push(retentionScore(p.ai_content, p.content).score);
      // Measured on prod: retentionScore FLOORS OUT at this granularity. Of 36
      // published posts, 13 were byte-identical to the draft and 6 more were
      // edited in ways too light to register — so 19 scored exactly 1.0 and the
      // median said nothing. The score discriminates heavy rewriting well and
      // light editing not at all. So pair it with the crude, sensitive question:
      // did they change ANYTHING? The two together cover the range.
      if (p.ai_content.trim() === p.content.trim()) b.unedited++;
    }
  }

  return [...buckets.entries()].map(([source, b]) => ({
    source,
    label:          LABELS[source] || source,
    generated:      b.generated,
    published:      b.published,
    publish_rate:   b.generated ? Math.round((b.published / b.generated) * 1000) / 10 : null,
    // Median, not mean: one heavily-rewritten post should not drag a path's score
    // the way a mean would at these sample sizes.
    // Share of published posts shipped exactly as generated. The sensitive half
    // of the pair — it separates "published verbatim" from "tidied up", which
    // median_kept cannot.
    unedited_rate:  b.kept.length ? Math.round((b.unedited / b.kept.length) * 1000) / 10 : null,
    median_kept:    median(b.kept),
    kept_n:         b.kept.length,
    median_gate:    median(b.gate),
  }));
}

module.exports = { buildVaultPathReport, aggregatePosts, median, VAULT_SOURCES, LABELS };

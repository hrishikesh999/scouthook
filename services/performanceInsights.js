'use strict';

/**
 * services/performanceInsights.js — per-author performance learning (Authentic
 * Client Engine, Phase 4.2).
 *
 * Aggregates a workspace's published posts by format/post-type and surfaces what
 * is actually working FOR THIS AUTHOR — never cross-user. Engagement is scored
 * relative to the author's own trailing median so a small account and a large
 * one both get honest signal.
 *
 * Guard rails (trust > coverage):
 *  - No insight until there are enough posts overall and enough in a bucket.
 *    Shipping "your story posts outperform" off n=2 destroys credibility.
 *  - The manual performance_tag (strong/decent/weak) captures impressions/DMs the
 *    member API can't see, so it nudges a post's score up or down a band.
 *
 * computeInsights() is pure (takes rows, returns the insight object) so it can be
 * unit-tested without a DB. getWorkspaceInsights() does the query + calls it.
 */

const { db } = require('../db');

const MIN_POSTS_TOTAL  = 6;   // don't say anything until the author has a track record
const MIN_POSTS_BUCKET = 3;   // a bucket needs this many posts to be comparable

// Human labels for the post_type / format buckets we group on.
const TYPE_LABELS = {
  trust: 'authority', story: 'story', lessons_learned: 'lessons', bts: 'behind-the-scenes',
  contrarian: 'contrarian', framework: 'framework', announcement: 'announcement',
  lead_gen: 'lead-gen', pis: 'problem-solution', results: 'results',
  reach: 'story', convert: 'offer',
};

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Comments are weighted 3× — they're the client-conversation signal, not vanity.
function engagementScore(row) {
  const reactions = Number(row.reactions) || Number(row.likes) || 0;
  const comments  = Number(row.comments)  || 0;
  let score = reactions + 3 * comments;
  // Manual tag adjustment: strong/weak shift the score to reflect off-platform
  // signal (impressions, DMs) the API can't see.
  if (row.performance_tag === 'strong') score *= 1.5;
  else if (row.performance_tag === 'weak') score *= 0.5;
  return score;
}

function bucketKey(row) {
  return row.post_type || row.funnel_type || row.format_slug || 'other';
}

function bucketLabel(key) {
  return TYPE_LABELS[key] || String(key).replace(/_/g, ' ');
}

/**
 * @param {Array} rows  published posts with { post_type, funnel_type, format_slug,
 *                       reactions, likes, comments, performance_tag }
 * @returns {{ insufficient_data: boolean, topBucket?, laggingBucket?, insights? }}
 */
function computeInsights(rows) {
  const posts = Array.isArray(rows) ? rows : [];
  if (posts.length < MIN_POSTS_TOTAL) {
    return { insufficient_data: true, reason: 'not_enough_posts', have: posts.length, need: MIN_POSTS_TOTAL };
  }

  const scores = posts.map(engagementScore);
  const authorMedian = median(scores);

  // Group scores by bucket.
  const buckets = new Map();
  posts.forEach((row, i) => {
    const key = bucketKey(row);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(scores[i]);
  });

  // Only buckets with enough posts are comparable.
  const ranked = [...buckets.entries()]
    .filter(([, arr]) => arr.length >= MIN_POSTS_BUCKET)
    .map(([key, arr]) => ({
      key,
      label: bucketLabel(key),
      count: arr.length,
      avg:   arr.reduce((a, b) => a + b, 0) / arr.length,
    }))
    .sort((a, b) => b.avg - a.avg);

  if (ranked.length < 2) {
    return { insufficient_data: true, reason: 'not_enough_comparable_buckets', have: ranked.length };
  }

  const top = ranked[0];
  const lag = ranked[ranked.length - 1];

  const insights = [];
  // Only claim an edge if it's meaningful (top ≥ 1.5× the laggard and above median).
  if (lag.avg > 0 && top.avg >= 1.5 * lag.avg && top.avg >= authorMedian) {
    const ratio = Math.round((top.avg / Math.max(lag.avg, 1)) * 10) / 10;
    insights.push({
      kind: 'top_format',
      text: `Your ${top.label} posts get about ${ratio}× the engagement of your ${lag.label} posts.`,
      evidence: `${top.label}: ${top.count} posts · ${lag.label}: ${lag.count} posts`,
    });
  } else {
    insights.push({
      kind: 'top_format',
      text: `Your ${top.label} posts are currently your strongest format.`,
      evidence: `${top.count} ${top.label} posts vs your trailing median`,
    });
  }

  return {
    insufficient_data: false,
    topBucket:     top,
    laggingBucket: lag,
    authorMedian,
    sampleSize:    posts.length,
    insights,
  };
}

/**
 * Query a workspace's recent published posts and compute insights.
 * @param {string} workspaceId
 * @param {{ days?: number }} [opts]
 */
async function getWorkspaceInsights(workspaceId, { days = 90 } = {}) {
  let rows = [];
  try {
    rows = await db.prepare(`
      SELECT post_type, funnel_type, format_slug,
             reactions, likes, comments, performance_tag
      FROM   generated_posts
      WHERE  tenant_id = ? AND status = 'published'
        AND  published_at > now() - ($2::text || ' days')::interval
    `).all(workspaceId, String(days));
  } catch (err) {
    console.error('[performanceInsights] query failed:', err.message);
    return { insufficient_data: true, reason: 'query_failed' };
  }
  return computeInsights(rows);
}

module.exports = {
  computeInsights,
  getWorkspaceInsights,
  engagementScore,
  MIN_POSTS_TOTAL,
  MIN_POSTS_BUCKET,
};

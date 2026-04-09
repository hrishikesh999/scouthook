'use strict';

const { db } = require('../db');
const { getValidAccessToken } = require('./linkedinOAuth');

const LINKEDIN_API_BASE    = 'https://api.linkedin.com';
const LINKEDIN_API_VERSION = '2026-03';
// Minimum gap between live API calls for the same post (milliseconds)
const COOLDOWN_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Typed error for LinkedIn 429 responses — lets the route layer return a
// clean 429 without logging it as an unexpected server error.
// ---------------------------------------------------------------------------
class RateLimitError extends Error {
  constructor(message = 'LinkedIn rate limit reached') {
    super(message);
    this.name = 'RateLimitError';
  }
}

// ---------------------------------------------------------------------------
// syncPostMetrics(postId, userId, tenantId)
//
// Fetches fresh engagement data for a single published post from LinkedIn's
// Social Metadata API (version 2026-03) and persists it to generated_posts.
//
// Returns { likes, comments, reactions, lastSynced }.
// Throws RateLimitError on LinkedIn 429.
// Throws Error('not_connected') / Error('reconnect_required') from OAuth layer.
// Throws Error('post_not_found') if the postId doesn't exist for this user.
// Throws Error('no_linkedin_id') if the post was published before we started
//   persisting linkedin_post_id (pre-migration publish).
// ---------------------------------------------------------------------------
async function syncPostMetrics(postId, userId, tenantId) {
  const row = await db.prepare(`
    SELECT id, likes, comments, reactions, linkedin_post_id, last_synced_at
    FROM   generated_posts
    WHERE  id = ? AND user_id = ? AND tenant_id = ? AND status = 'published'
  `).get(postId, userId, tenantId);

  if (!row) throw new Error('post_not_found');
  if (!row.linkedin_post_id) throw new Error('no_linkedin_id');

  // Return cached values if synced within the cooldown window
  if (row.last_synced_at) {
    const age = Date.now() - new Date(row.last_synced_at).getTime();
    if (age < COOLDOWN_MS) {
      return {
        likes:       row.likes      ?? 0,
        comments:    row.comments   ?? 0,
        reactions:   row.reactions  ?? 0,
        lastSynced:  row.last_synced_at,
        fromCache:   true,
      };
    }
  }

  // Fetch a fresh access token (handles refresh transparently)
  const accessToken = await getValidAccessToken(userId, tenantId);

  // linkedin_post_id is stored as the full URN (e.g. "urn:li:share:123") — use it directly
  const shareUrn    = row.linkedin_post_id;
  const encodedUrn  = encodeURIComponent(shareUrn);
  const url = `${LINKEDIN_API_BASE}/rest/socialMetadata?ids=List(${encodedUrn})`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization':              `Bearer ${accessToken}`,
      'LinkedIn-Version':           LINKEDIN_API_VERSION,
      'X-Restli-Protocol-Version':  '2.0.0',
    },
  });

  if (response.status === 429) {
    throw new RateLimitError();
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`LinkedIn API error ${response.status}: ${body}`);
  }

  const data = await response.json();

  // The response is a results map keyed by URN
  const entry = data?.results?.[shareUrn] ?? data?.results?.[encodedUrn] ?? {};

  // Sum all reaction types for the reactions column;
  // use the LIKE bucket specifically for the likes column
  const reactionSummaries = entry.reactionsSummary?.reactionSummaries ?? [];
  let likes     = 0;
  let reactions = 0;
  for (const summary of reactionSummaries) {
    const count = summary.count ?? 0;
    reactions += count;
    if (summary.reactionType === 'LIKE') likes = count;
  }

  // Total reaction count (all types) can also come from a top-level summary
  if (entry.reactionsSummary?.totalReactionCount != null) {
    reactions = entry.reactionsSummary.totalReactionCount;
  }

  const comments = entry.commentsSummary?.totalFirstLevelComments
    ?? entry.commentsSummary?.count
    ?? 0;

  const lastSynced = new Date().toISOString();

  await db.prepare(`
    UPDATE generated_posts
    SET    likes = ?, comments = ?, reactions = ?, last_synced_at = ?
    WHERE  id = ?
  `).run(likes, comments, reactions, lastSynced, postId);

  console.log(`[linkedinMetrics] synced post=${postId} likes=${likes} comments=${comments} reactions=${reactions}`);

  return { likes, comments, reactions, lastSynced, fromCache: false };
}

module.exports = { syncPostMetrics, RateLimitError };

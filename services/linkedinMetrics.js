'use strict';

const { db } = require('../db');
const { getValidAccessToken } = require('./linkedinOAuth');

const LINKEDIN_API_BASE    = 'https://api.linkedin.com';
const LINKEDIN_API_VERSION = '202501';
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
// resolveWorkspaceToken(workspaceId)
//
// Returns a decrypted access token for the workspace's default LinkedIn
// connection. Throws 'not_connected' or 'reconnect_required' if unavailable.
// Token refresh for linkedin_connections is Sprint 3 work — for now we throw
// reconnect_required when the token is expiring soon.
// ---------------------------------------------------------------------------
async function resolveWorkspaceToken(workspaceId) {
  // Delegates to the shared token getter: handles refresh, reconnect notifications,
  // and filters to account_type='personal' — consistent with the publisher path.
  return getValidAccessToken(workspaceId);
}

// ---------------------------------------------------------------------------
// fetchLinkedInMetrics(accessToken, shareUrn)
//
// Calls LinkedIn Social Metadata API and returns { likes, comments, reactions }.
// Throws RateLimitError on 429, Error on other failures.
// ---------------------------------------------------------------------------
async function fetchLinkedInMetrics(accessToken, shareUrn) {
  const encodedUrn = encodeURIComponent(shareUrn);
  const url = `${LINKEDIN_API_BASE}/rest/socialMetadata?ids=List(${encodedUrn})`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization':              `Bearer ${accessToken}`,
      'LinkedIn-Version':           LINKEDIN_API_VERSION,
      'X-Restli-Protocol-Version':  '2.0.0',
    },
  });

  if (response.status === 429) throw new RateLimitError();

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`LinkedIn API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  const entry = data?.results?.[shareUrn] ?? data?.results?.[encodedUrn] ?? {};

  // Sum all reaction types; use LIKE bucket for the likes column
  const reactionSummaries = entry.reactionsSummary?.reactionSummaries ?? [];
  let likes     = 0;
  let reactions = 0;
  for (const summary of reactionSummaries) {
    const count = summary.count ?? 0;
    reactions += count;
    if (summary.reactionType === 'LIKE') likes = count;
  }
  if (entry.reactionsSummary?.totalReactionCount != null) {
    reactions = entry.reactionsSummary.totalReactionCount;
  }

  const comments = entry.commentsSummary?.totalFirstLevelComments
    ?? entry.commentsSummary?.count
    ?? 0;

  return { likes, comments, reactions };
}

// ---------------------------------------------------------------------------
// syncPostMetrics(postId, tenantId)
//
// Fetches fresh engagement data for a single published post and persists it.
// Token is sourced from the workspace's default linkedin_connections row.
//
// Returns { likes, comments, reactions, lastSynced, fromCache }.
// Throws RateLimitError on LinkedIn 429.
// Throws Error('not_connected') / Error('reconnect_required') if no valid token.
// Throws Error('post_not_found') if postId doesn't exist in this workspace.
// Throws Error('no_linkedin_id') if the post has no linkedin_post_id.
// ---------------------------------------------------------------------------
async function syncPostMetrics(postId, tenantId) {
  const row = await db.prepare(`
    SELECT id, likes, comments, reactions, linkedin_post_id, last_synced_at
    FROM   generated_posts
    WHERE  id = ? AND tenant_id = ? AND status = 'published'
  `).get(postId, tenantId);

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

  const accessToken = await resolveWorkspaceToken(tenantId);
  const { likes, comments, reactions } = await fetchLinkedInMetrics(accessToken, row.linkedin_post_id);
  const lastSynced = new Date().toISOString();

  await db.prepare(`
    UPDATE generated_posts
    SET    likes = ?, comments = ?, reactions = ?, last_synced_at = ?
    WHERE  id = ? AND tenant_id = ?
  `).run(likes, comments, reactions, lastSynced, postId, tenantId);

  console.log(`[linkedinMetrics] synced post=${postId} likes=${likes} comments=${comments} reactions=${reactions}`);

  return { likes, comments, reactions, lastSynced, fromCache: false };
}

// ---------------------------------------------------------------------------
// syncWorkspaceMetrics(workspaceId)
//
// Batch-syncs all published posts in a workspace that are past the cooldown
// window. Uses the workspace's default LinkedIn connection token.
//
// Called by admin routes and future cron jobs. Returns a summary object.
// ---------------------------------------------------------------------------
async function syncWorkspaceMetrics(workspaceId) {
  let accessToken;
  try {
    accessToken = await resolveWorkspaceToken(workspaceId);
  } catch {
    // Workspace has no valid connection — skip silently
    return { synced: 0, skipped: 0, errors: 0 };
  }

  const posts = await db.prepare(`
    SELECT id, linkedin_post_id, last_synced_at
    FROM   generated_posts
    WHERE  tenant_id = ? AND status = 'published' AND linkedin_post_id IS NOT NULL
  `).all(workspaceId);

  let synced = 0, skipped = 0, errors = 0;

  for (const post of posts) {
    if (post.last_synced_at) {
      const age = Date.now() - new Date(post.last_synced_at).getTime();
      if (age < COOLDOWN_MS) { skipped++; continue; }
    }

    try {
      const { likes, comments, reactions } = await fetchLinkedInMetrics(accessToken, post.linkedin_post_id);
      const lastSynced = new Date().toISOString();
      await db.prepare(`
        UPDATE generated_posts
        SET    likes = ?, comments = ?, reactions = ?, last_synced_at = ?
        WHERE  id = ? AND tenant_id = ?
      `).run(likes, comments, reactions, lastSynced, post.id, workspaceId);
      synced++;
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.warn(`[linkedinMetrics] rate limited during workspace sync, stopping early`);
        break;
      }
      errors++;
    }
  }

  console.log(`[linkedinMetrics] workspace=${workspaceId} synced=${synced} skipped=${skipped} errors=${errors}`);
  return { synced, skipped, errors };
}

module.exports = { syncPostMetrics, syncWorkspaceMetrics, RateLimitError };

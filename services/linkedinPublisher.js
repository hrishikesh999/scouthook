'use strict';

const { db } = require('../db');
const { getValidAccessToken } = require('./linkedinOAuth');

const LINKEDIN_UGC_URL = 'https://api.linkedin.com/v2/ugcPosts';
const RATE_LIMIT_WINDOW_HOURS = 1;

// ---------------------------------------------------------------------------
// Rate limit check — 1 published post per hour per user
// ---------------------------------------------------------------------------

function checkRateLimit(userId, tenantId) {
  const { cnt } = db.prepare(`
    SELECT COUNT(*) AS cnt FROM scheduled_posts
    WHERE user_id = ? AND tenant_id = ?
      AND status = 'published'
      AND updated_at > datetime('now', ?)
  `).get(userId, tenantId, `-${RATE_LIMIT_WINDOW_HOURS} hours`);

  if (cnt > 0) {
    throw Object.assign(new Error('rate_limit_exceeded'), { statusCode: 429 });
  }
}

// ---------------------------------------------------------------------------
// Core LinkedIn publish call
// ---------------------------------------------------------------------------

async function callLinkedInAPI(accessToken, linkedinUserId, content) {
  const body = {
    author: `urn:li:person:${linkedinUserId}`,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text: content },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
    },
  };

  const res = await fetch(LINKEDIN_UGC_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': '202308',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LinkedIn API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.id; // e.g. "urn:li:ugcPost:1234567890"
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Publish a post immediately to LinkedIn.
 * @param {string} userId
 * @param {string} tenantId
 * @param {string} content
 * @returns {Promise<{ linkedin_post_id: string }>}
 */
async function publishNow(userId, tenantId, content) {
  // Rate limit — 1 post/hour
  checkRateLimit(userId, tenantId);

  // Get LinkedIn user ID (needed for author URN)
  const tokenRow = db.prepare(
    'SELECT linkedin_user_id FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
  ).get(userId, tenantId);

  if (!tokenRow?.linkedin_user_id) throw new Error('not_connected');

  const accessToken = await getValidAccessToken(userId, tenantId);
  const linkedin_post_id = await callLinkedInAPI(accessToken, tokenRow.linkedin_user_id, content);

  return { linkedin_post_id };
}

/**
 * BullMQ job handler — publish a scheduled post.
 * Throws on failure so BullMQ can retry (up to 3 attempts with exponential backoff).
 * @param {number} scheduledPostId
 */
async function publishScheduledPost(scheduledPostId) {
  const row = db.prepare(
    'SELECT * FROM scheduled_posts WHERE id = ? AND status = ?'
  ).get(scheduledPostId, 'pending');

  if (!row) {
    // Already cancelled, published, or doesn't exist — silently skip
    console.log(`[publisher] scheduledPostId=${scheduledPostId} not pending — skipping`);
    return;
  }

  // Mark as processing
  db.prepare(`
    UPDATE scheduled_posts SET status = 'processing', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(scheduledPostId);

  try {
    const { linkedin_post_id } = await publishNow(row.user_id, row.tenant_id, row.content);

    db.prepare(`
      UPDATE scheduled_posts SET status = 'published', linkedin_post_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(linkedin_post_id, scheduledPostId);

    console.log(`[publisher] scheduledPostId=${scheduledPostId} published as ${linkedin_post_id}`);
  } catch (err) {
    db.prepare(`
      UPDATE scheduled_posts SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(err.message, scheduledPostId);

    // Re-throw so BullMQ retries
    throw err;
  }
}

module.exports = { publishNow, publishScheduledPost };

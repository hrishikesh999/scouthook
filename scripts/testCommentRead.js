'use strict';

/**
 * testCommentRead.js — Verify LinkedIn Comment Read + Reply API access
 *
 * Tests two things needed for the Comment Reply Copilot:
 *   1. Can we READ comments on our own posts with w_member_social?
 *   2. Does the response include the fields we need (actor, message, commentUrn)?
 *
 * Usage:
 *   node scripts/testCommentRead.js
 *   node scripts/testCommentRead.js --dry-reply   # also test reply creation (posts a test reply)
 *
 * Requires: .env loaded (DATABASE_URL, TOKEN_ENCRYPTION_KEY)
 */

require('dotenv').config();

const { db } = require('../db');
const { pool } = require('../db/pg');
const { getValidAccessToken } = require('../services/linkedinOAuth');

const LINKEDIN_API_VERSION = '202603';
const FETCH_TIMEOUT_MS = 15_000;
const DRY_REPLY = process.argv.includes('--dry-reply');

async function linkedInFetch(url, accessToken, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'LinkedIn-Version': LINKEDIN_API_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
        ...options.headers,
      },
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`LinkedIn API timeout (${FETCH_TIMEOUT_MS}ms)`);
    }
    throw err;
  }
}

async function run() {
  // 1. Find a workspace with a LinkedIn connection
  const connection = await db.prepare(`
    SELECT lc.workspace_id, lc.linkedin_member_id, lc.display_name, w.name AS workspace_name
    FROM linkedin_connections lc
    JOIN workspaces w ON w.id = lc.workspace_id
    WHERE lc.account_type = 'personal' AND lc.is_default = true
    LIMIT 1
  `).get();

  if (!connection) {
    console.error('[test] No workspace with LinkedIn connection found.');
    return { ok: false, reason: 'no_connection' };
  }

  const workspaceId = connection.workspace_id;
  const memberUrn = connection.linkedin_member_id
    ? `urn:li:person:${connection.linkedin_member_id}`
    : null;

  console.log('[test] Workspace: %s (%s)', connection.workspace_name, workspaceId);
  console.log('[test] LinkedIn member: %s (%s)', connection.display_name, memberUrn || 'unknown URN');

  // 2. Find a published post with comments (prefer posts that have engagement)
  const post = await db.prepare(`
    SELECT id, linkedin_post_id, content, comments, published_at
    FROM generated_posts
    WHERE tenant_id = ?
      AND linkedin_post_id IS NOT NULL
    ORDER BY comments DESC NULLS LAST, published_at DESC NULLS LAST
    LIMIT 1
  `).get(workspaceId);

  if (!post?.linkedin_post_id) {
    console.error('[test] No published post with linkedin_post_id found.');
    return { ok: false, reason: 'no_published_post' };
  }

  const preview = post.content
    ? post.content.slice(0, 80) + (post.content.length > 80 ? '...' : '')
    : '(empty)';
  console.log('[test] Post #%d: %s', post.id, post.linkedin_post_id);
  console.log('[test] Preview: %s', preview);
  console.log('[test] Stored comment count: %d', post.comments || 0);

  // 3. Get access token
  let accessToken;
  try {
    accessToken = await getValidAccessToken(workspaceId);
    console.log('[test] Access token: OK (length=%d)', accessToken.length);
  } catch (err) {
    console.error('[test] Token error: %s', err.message);
    return { ok: false, reason: 'token_error', detail: err.message };
  }

  // 4. Test: READ comments
  console.log('\n--- Test 1: Read comments ---');
  const shareUrn = post.linkedin_post_id;
  const commentsUrl = `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(shareUrn)}/comments`;

  let res;
  try {
    res = await linkedInFetch(commentsUrl, accessToken);
  } catch (err) {
    console.error('[test] Fetch failed: %s', err.message);
    return { ok: false, reason: 'fetch_error', detail: err.message };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[test] FAILED — HTTP %d', res.status);
    console.error('[test] Body: %s', body.slice(0, 300));
    if (res.status === 403) {
      console.error('[test] 403 = w_member_social cannot read comments. Need r_member_social_feed (restricted).');
    } else if (res.status === 401) {
      console.error('[test] 401 = Token expired or revoked. Reconnect LinkedIn.');
    } else if (res.status === 429) {
      console.error('[test] 429 = Rate limited. Wait and retry.');
    }
    return { ok: false, reason: `http_${res.status}` };
  }

  let data;
  const rawText = await res.text();
  try {
    data = JSON.parse(rawText);
  } catch {
    console.error('[test] Response is not JSON: %s', rawText.slice(0, 200));
    return { ok: false, reason: 'invalid_json' };
  }

  const comments = data.elements || [];
  const paging = data.paging || {};
  const selfComments = comments.filter(c => c.actor === memberUrn);
  const otherComments = comments.filter(c => c.actor !== memberUrn);

  console.log('[test] Read comments: SUCCESS');
  console.log('[test] Total on this page: %d (self: %d, others: %d)', comments.length, selfComments.length, otherComments.length);
  if (paging.total != null) {
    console.log('[test] Total comments (all pages): %d', paging.total);
  }
  if (paging.count != null && paging.start != null) {
    console.log('[test] Pagination: start=%d, count=%d', paging.start, paging.count);
  }

  // Show sample comments
  for (const c of otherComments.slice(0, 3)) {
    const msg = c.message?.text || '(no text)';
    const time = c.created?.time ? new Date(c.created.time).toISOString() : '?';
    const hasUrn = !!c.commentUrn;
    console.log('[test]   [%s] %s: "%s" (URN: %s)', time, c.actor, msg.slice(0, 60), hasUrn ? 'yes' : 'MISSING');
  }

  // Verify required fields exist
  const sampleComment = comments[0];
  if (sampleComment) {
    const fields = ['actor', 'message', 'commentUrn', 'id', 'created', 'object'];
    const missing = fields.filter(f => sampleComment[f] == null);
    if (missing.length > 0) {
      console.warn('[test] WARNING: comment missing fields: %s', missing.join(', '));
    } else {
      console.log('[test] All required fields present (actor, message, commentUrn, id, created, object)');
    }
  }

  // 5. Test: Reply creation (only with --dry-reply flag)
  if (DRY_REPLY && otherComments.length > 0) {
    console.log('\n--- Test 2: Reply to comment (--dry-reply) ---');
    const target = otherComments[0];
    const actorUrn = memberUrn;

    if (!actorUrn) {
      console.error('[test] Cannot test reply: linkedin_member_id not stored in connection.');
      return { ok: true, readComments: true, replyTest: false, reason: 'no_member_id' };
    }

    const replyUrl = `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(target.commentUrn)}/comments`;
    const replyBody = {
      actor: actorUrn,
      object: target.object,
      parentComment: target.commentUrn,
      message: { text: 'Thanks for your thoughts! (ScoutHook test reply — will delete)' },
    };

    console.log('[test] Replying to: "%s"', (target.message?.text || '').slice(0, 60));
    console.log('[test] Reply URL: %s', replyUrl);

    try {
      const replyRes = await linkedInFetch(replyUrl, accessToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(replyBody),
      });

      if (!replyRes.ok) {
        const errBody = await replyRes.text().catch(() => '');
        console.error('[test] Reply FAILED — HTTP %d: %s', replyRes.status, errBody.slice(0, 300));
        return { ok: true, readComments: true, replyTest: false, reason: `reply_http_${replyRes.status}` };
      }

      const replyData = await replyRes.json().catch(() => ({}));
      console.log('[test] Reply SUCCESS — comment ID: %s', replyData.id || 'unknown');
      console.log('[test] NOTE: Delete this test reply from LinkedIn manually.');
      return { ok: true, readComments: true, replyTest: true };
    } catch (err) {
      console.error('[test] Reply fetch error: %s', err.message);
      return { ok: true, readComments: true, replyTest: false, reason: err.message };
    }
  }

  console.log('\n--- Summary ---');
  console.log('[test] Read comments: YES (w_member_social works)');
  console.log('[test] Comments to reply to: %d', otherComments.length);
  if (!DRY_REPLY) {
    console.log('[test] Reply test: SKIPPED (run with --dry-reply to test posting a reply)');
  }
  console.log('[test] Proceed with Comment Reply Copilot build.');

  return { ok: true, readComments: true, commentCount: comments.length, otherCount: otherComments.length };
}

run()
  .then(result => {
    console.log('\n[test] Result:', JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  })
  .catch(err => {
    console.error('[test] Unexpected error:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    pool.end().then(() => process.exit());
  });

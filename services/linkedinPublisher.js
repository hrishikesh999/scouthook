'use strict';

const { db, backendKind } = require('../db');
const { getValidAccessToken } = require('./linkedinOAuth');
const path = require('path');
const storage = require('./storage');
const crypto = require('crypto');

const LINKEDIN_UGC_URL = 'https://api.linkedin.com/v2/ugcPosts';
/** Consumer "Share on LinkedIn" image flow — not rest/images + rest/posts (Marketing). */
const LINKEDIN_ASSETS_REGISTER_URL = 'https://api.linkedin.com/v2/assets?action=registerUpload';
const LINKEDIN_DOC_INIT_URL = 'https://api.linkedin.com/rest/documents?action=initializeUpload';
const LINKEDIN_REST_POSTS_URL = 'https://api.linkedin.com/rest/posts';
const LINKEDIN_API_VERSION = '202501';
const RATE_LIMIT_WINDOW_HOURS = 1;

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Rate limit check — 1 published post per hour per user
// ---------------------------------------------------------------------------

function checkRateLimit(userId, tenantId) {
  const sql = backendKind === 'sqlite'
    ? `
      SELECT COUNT(*) AS cnt FROM scheduled_posts
      WHERE user_id = ? AND tenant_id = ?
        AND status = 'published'
        AND updated_at > datetime('now', ?)
    `
    : `
      SELECT COUNT(*)::int AS cnt FROM scheduled_posts
      WHERE user_id = ? AND tenant_id = ?
        AND status = 'published'
        AND updated_at > (now() - ($3::text)::interval)
    `;

  return db.prepare(sql).get(
    userId,
    tenantId,
    backendKind === 'sqlite' ? `-${RATE_LIMIT_WINDOW_HOURS} hours` : `${RATE_LIMIT_WINDOW_HOURS} hours`
  ).then(({ cnt } = {}) => {
    if ((cnt ?? 0) > 0) {
      throw Object.assign(new Error('rate_limit_exceeded'), { statusCode: 429 });
    }
  });
}

// ---------------------------------------------------------------------------
// Core LinkedIn publish call
// ---------------------------------------------------------------------------

/**
 * Register a feed-share image upload (consumer API). Returns digitalmediaAsset URN + upload URL.
 * @see https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin
 */
async function registerFeedshareImageUpload(accessToken, ownerUrn) {
  const res = await fetch(LINKEDIN_ASSETS_REGISTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': LINKEDIN_API_VERSION,
    },
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
        owner: ownerUrn,
        serviceRelationships: [
          {
            relationshipType: 'OWNER',
            identifier: 'urn:li:userGeneratedContent',
          },
        ],
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LinkedIn assets registerUpload error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const value = data.value ?? data;
  const asset = value.asset;
  const mechanism = value.uploadMechanism?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'];
  const uploadUrl = mechanism?.uploadUrl;
  const uploadHeaders = mechanism?.headers && typeof mechanism.headers === 'object' ? mechanism.headers : {};

  if (!asset || !uploadUrl) {
    throw new Error('LinkedIn registerUpload returned no asset/uploadUrl');
  }
  return { asset, uploadUrl, uploadHeaders };
}

async function uploadFeedshareImageBinary(accessToken, uploadUrl, buffer, extraHeaders = {}) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'image/png',
      ...extraHeaders,
    },
    body: buffer,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LinkedIn feedshare image upload error ${res.status}: ${text}`);
  }
}

/** UGC post with image — uses urn:li:digitalmediaAsset from v2/assets (consumer flow). */
async function createUgcPostWithImage(accessToken, linkedinUserId, content, assetUrn) {
  const ownerUrn = `urn:li:person:${linkedinUserId}`;
  const body = {
    author: ownerUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text: content },
        shareMediaCategory: 'IMAGE',
        media: [
          {
            status: 'READY',
            media: assetUrn,
          },
        ],
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
      'LinkedIn-Version': LINKEDIN_API_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LinkedIn API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.id;
}

/** Text-only organic post (legacy UGC endpoint; still reliable for commentary-only). */
async function callLinkedInAPI(accessToken, linkedinUserId, content) {
  const ownerUrn = `urn:li:person:${linkedinUserId}`;
  const body = {
    author: ownerUrn,
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
      'LinkedIn-Version': LINKEDIN_API_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LinkedIn API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.id;
}

async function createRestPostWithMedia(accessToken, linkedinUserId, commentary, mediaPayload) {
  const body = {
    author: `urn:li:person:${linkedinUserId}`,
    commentary,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    content: { media: mediaPayload },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  const res = await fetch(LINKEDIN_REST_POSTS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': LINKEDIN_API_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LinkedIn rest/posts error ${res.status}: ${text}`);
  }

  const restliId = res.headers.get('x-restli-id');
  if (restliId) return restliId;
  const raw = await res.text();
  if (raw) {
    try {
      const data = JSON.parse(raw);
      if (data.id) return data.id;
    } catch { /* ignore */ }
  }
  return 'urn:li:share:unknown';
}

/**
 * Read asset bytes from storage for LinkedIn upload.
 * Supports /files/ (generated) and /uploads/ (media library) URL paths.
 * @param {string} urlPath  — e.g. '/files/foo.png' or '/uploads/bar.pdf'
 * @param {string} userId
 * @param {string} tenantId
 * @returns {Promise<Buffer|null>}
 */
async function readStoredFileBytes(urlPath, userId, tenantId) {
  if (!urlPath || typeof urlPath !== 'string') return null;

  let type, filename;
  if (urlPath.startsWith('/files/')) {
    type = 'generated';
    filename = urlPath.slice('/files/'.length);
  } else if (urlPath.startsWith('/uploads/')) {
    type = 'uploads';
    filename = urlPath.slice('/uploads/'.length);
  } else {
    return null;
  }

  // Validate bare filename — no path separators, safe chars only
  if (!filename || filename !== path.basename(filename)) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) return null;

  try {
    return await storage.download(storage.buildKey(tenantId, userId, type, filename));
  } catch {
    return null;
  }
}

async function initializeDocumentUpload(accessToken, ownerUrn) {
  const res = await fetch(LINKEDIN_DOC_INIT_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': LINKEDIN_API_VERSION,
    },
    body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LinkedIn document initializeUpload error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const v = data.value ?? data;
  const uploadUrl = v.uploadUrl;
  const document = v.document;
  if (!uploadUrl || !document) {
    throw new Error('LinkedIn document initializeUpload returned no uploadUrl/document');
  }
  return { uploadUrl, document };
}

async function uploadDocumentPdf(accessToken, uploadUrl, buffer) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/pdf',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': LINKEDIN_API_VERSION,
    },
    body: buffer,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LinkedIn document upload error ${res.status}: ${text}`);
  }
}

async function waitForDocumentAvailable(accessToken, documentUrn) {
  await sleep(600);
  const encoded = encodeURIComponent(documentUrn);
  for (let i = 0; i < 45; i++) {
    const res = await fetch(`https://api.linkedin.com/rest/documents/${encoded}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'X-Restli-Protocol-Version': '2.0.0',
        'LinkedIn-Version': LINKEDIN_API_VERSION,
      },
    });

    if (res.ok) {
      const doc = await res.json();
      if (doc.status === 'AVAILABLE') return;
      if (doc.status === 'PROCESSING_FAILED') {
        throw new Error('linkedin_document_processing_failed');
      }
    }
    await sleep(1500);
  }
  throw new Error('linkedin_document_not_ready');
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
async function publishNow(userId, tenantId, content, options = {}) {
  // Rate limit — 1 post/hour
  await checkRateLimit(userId, tenantId);

  // Get LinkedIn user ID (needed for author URN)
  const tokenRow = await db.prepare(
    'SELECT linkedin_user_id FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
  ).get(userId, tenantId);

  if (!tokenRow?.linkedin_user_id) throw new Error('not_connected');

  const accessToken = await getValidAccessToken(userId, tenantId);
  const personId = tokenRow.linkedin_user_id;
  const ownerUrn = `urn:li:person:${personId}`;

  if (options.carousel_pdf_url) {
    const pdfBytes = await readStoredFileBytes(options.carousel_pdf_url, userId, tenantId);
    if (!pdfBytes) throw new Error('invalid_carousel_pdf_url');

    const { uploadUrl, document } = await initializeDocumentUpload(accessToken, ownerUrn);
    await uploadDocumentPdf(accessToken, uploadUrl, pdfBytes);
    await waitForDocumentAvailable(accessToken, document);
    const linkedin_post_id = await createRestPostWithMedia(accessToken, personId, content, {
      title: 'Carousel.pdf',
      id: document,
    });
    return { linkedin_post_id };
  }

  if (options.image_url) {
    const bytes = await readStoredFileBytes(options.image_url, userId, tenantId);
    if (!bytes) throw new Error('invalid_image_url');

    const { asset, uploadUrl, uploadHeaders } = await registerFeedshareImageUpload(accessToken, ownerUrn);
    await uploadFeedshareImageBinary(accessToken, uploadUrl, bytes, uploadHeaders);
    await sleep(2000);
    const linkedin_post_id = await createUgcPostWithImage(accessToken, personId, content, asset);
    return { linkedin_post_id };
  }

  const linkedin_post_id = await callLinkedInAPI(accessToken, personId, content);
  return { linkedin_post_id };
}

// Errors that should NOT be retried — user action is needed to resolve them.
const NON_RETRIABLE_ERRORS = new Set([
  'not_connected',
  'rate_limit_exceeded',
  'scheduled_payload_mismatch',
  'invalid_carousel_pdf_url',
  'invalid_image_url',
  'reconnect_required',
  'scheduler_not_initialized',
]);

/**
 * BullMQ job handler — publish a scheduled post.
 * For transient failures (LinkedIn 429, network errors) the function resets
 * the row to 'pending' and throws so BullMQ retries with exponential backoff.
 * For non-retriable errors it marks the row 'not_sent' without throwing.
 * @param {number} scheduledPostId
 * @param {{ attemptsMade: number, maxAttempts: number }} [attemptInfo]
 */
async function publishScheduledPost(scheduledPostId, { attemptsMade = 0, maxAttempts = 3 } = {}) {
  const isFinalAttempt = (attemptsMade + 1) >= maxAttempts;
  const current = await db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(scheduledPostId);
  if (!current) {
    console.log(`[publisher] scheduledPostId=${scheduledPostId} not found — skipping`);
    return;
  }

  if (!['pending', 'processing'].includes(current.status)) {
    console.log(`[publisher] scheduledPostId=${scheduledPostId} status=${current.status} — skipping`);
    return;
  }

  // If already published, don't attempt again (idempotency guard).
  if (current.status === 'published' || current.linkedin_post_id) {
    console.log(`[publisher] scheduledPostId=${scheduledPostId} already published — skipping`);
    return;
  }

  // Claim the job if it's pending. For retries, we may see it pending again.
  if (current.status === 'pending') {
    const claim = await db.prepare(`
      UPDATE scheduled_posts
      SET status = 'processing',
          attempts = attempts + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'
    `).run(scheduledPostId);

    if (claim.changes === 0) {
      // Another worker claimed it or it was cancelled between reads.
      console.log(`[publisher] scheduledPostId=${scheduledPostId} could not be claimed — skipping`);
      return;
    }
  }

  try {
    // Re-fetch after claiming to get updated attempts/status.
    const row = await db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(scheduledPostId);
    if (!row || row.status !== 'processing') {
      console.log(`[publisher] scheduledPostId=${scheduledPostId} not processing — skipping`);
      return;
    }

    // Integrity check: ensure the scheduled payload hasn't been mutated.
    // (Defends against accidental writes or tampering.)
    if (row.payload_hash) {
      const computed = sha256Hex(JSON.stringify({
        content: row.content,
        asset_type: row.asset_type || null,
        asset_url: row.asset_url || null,
        scheduled_for: row.scheduled_for,
      }));
      if (computed !== row.payload_hash) {
        throw new Error('scheduled_payload_mismatch');
      }
    }

    try {
      await db.prepare(`
        INSERT INTO scheduled_post_events (scheduled_post_id, user_id, tenant_id, event_type, message)
        VALUES (?, ?, ?, 'started', ?)
      `).run(scheduledPostId, row.user_id, row.tenant_id, `attempt=${row.attempts}`);
    } catch { /* non-fatal */ }

    const publishOpts = {};
    if (row.asset_type === 'carousel' && row.asset_url) {
      publishOpts.carousel_pdf_url = row.asset_url;
    } else if (row.asset_type === 'image' && row.asset_url) {
      publishOpts.image_url = row.asset_url;
    }

    // Idempotency guard: if a previous attempt already obtained a linkedin_post_id
    // but failed to persist the 'published' status, skip the API call to avoid
    // publishing the same post twice.
    let linkedin_post_id = row.linkedin_post_id || null;
    if (linkedin_post_id) {
      console.log(`[publisher] scheduledPostId=${scheduledPostId} linkedin_post_id already set (${linkedin_post_id}) — skipping API call`);
    } else {
      ({ linkedin_post_id } = await publishNow(row.user_id, row.tenant_id, row.content, publishOpts));
    }

    await db.prepare(`
      UPDATE scheduled_posts SET status = 'published', linkedin_post_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(linkedin_post_id, scheduledPostId);

    try {
      await db.prepare(`
        INSERT INTO scheduled_post_events (scheduled_post_id, user_id, tenant_id, event_type, message)
        VALUES (?, ?, ?, 'published', ?)
      `).run(scheduledPostId, row.user_id, row.tenant_id, linkedin_post_id);
    } catch { /* non-fatal */ }

    // Stamp the originating draft as published
    if (row.post_id) {
      await db.prepare(`
        UPDATE generated_posts
        SET status = 'published', published_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ? AND tenant_id = ?
      `).run(row.post_id, row.user_id, row.tenant_id);
    }

    // Notify the user that their scheduled post was published.
    try {
      await db.prepare(`
        INSERT INTO notifications (user_id, tenant_id, type, title, body, ref_id, ref_type)
        VALUES (?, ?, 'publish_succeeded', 'Post published', ?, ?, 'scheduled_post')
      `).run(
        row.user_id,
        row.tenant_id,
        `Your scheduled post has been published to LinkedIn.`,
        scheduledPostId
      );
    } catch { /* non-fatal */ }

    console.log(`[publisher] scheduledPostId=${scheduledPostId} published as ${linkedin_post_id}`);
  } catch (err) {
    const isNonRetriable = NON_RETRIABLE_ERRORS.has(err.message) || isFinalAttempt;

    if (isNonRetriable) {
      // Permanent failure — mark not_sent and unlock the draft.
      await db.prepare(`
        UPDATE scheduled_posts
        SET status = 'not_sent', error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(err.message, scheduledPostId);

      try {
        const r = await db.prepare('SELECT user_id, tenant_id, post_id FROM scheduled_posts WHERE id = ?').get(scheduledPostId);
        if (r) {
          if (r.post_id) {
            await db.prepare(`
              UPDATE generated_posts
              SET status = 'draft'
              WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'scheduled'
            `).run(r.post_id, r.user_id, r.tenant_id);
          }
          await db.prepare(`
            INSERT INTO scheduled_post_events (scheduled_post_id, user_id, tenant_id, event_type, message)
            VALUES (?, ?, ?, 'not_sent', ?)
          `).run(scheduledPostId, r.user_id, r.tenant_id, err.message);
        }
      } catch { /* non-fatal */ }

      // Notify the user that their scheduled post could not be sent.
      try {
        const meta = await db.prepare('SELECT user_id, tenant_id FROM scheduled_posts WHERE id = ?').get(scheduledPostId);
        if (meta) {
          await db.prepare(`
            INSERT INTO notifications (user_id, tenant_id, type, title, body, ref_id, ref_type)
            VALUES (?, ?, 'publish_failed', 'Scheduled post failed', ?, ?, 'scheduled_post')
          `).run(
            meta.user_id,
            meta.tenant_id,
            `Your scheduled post could not be published: ${err.message}`,
            scheduledPostId
          );
        }
      } catch { /* non-fatal */ }

      console.warn(`[publisher] scheduledPostId=${scheduledPostId} not_sent (final):`, err.message);
      // Do not throw — BullMQ should not retry non-retriable failures.
    } else {
      // Transient failure — reset to pending so the next BullMQ attempt can claim it.
      await db.prepare(`
        UPDATE scheduled_posts
        SET status = 'pending', error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(err.message, scheduledPostId);

      try {
        const r = await db.prepare('SELECT user_id, tenant_id FROM scheduled_posts WHERE id = ?').get(scheduledPostId);
        if (r) {
          await db.prepare(`
            INSERT INTO scheduled_post_events (scheduled_post_id, user_id, tenant_id, event_type, message)
            VALUES (?, ?, ?, 'retry', ?)
          `).run(scheduledPostId, r.user_id, r.tenant_id, `attempt=${attemptsMade + 1}/${maxAttempts}: ${err.message}`);
        }
      } catch { /* non-fatal */ }

      console.warn(`[publisher] scheduledPostId=${scheduledPostId} will retry (attempt ${attemptsMade + 1}/${maxAttempts}):`, err.message);
      throw err; // Let BullMQ apply backoff and retry.
    }
  }
}

module.exports = { publishNow, publishScheduledPost };

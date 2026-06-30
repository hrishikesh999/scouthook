'use strict';

const { db } = require('../db');
const { encrypt, decrypt } = require('./linkedinOAuth');
const { sendEmailToUser } = require('../emails');
const path = require('path');
const storage = require('./storage');
const crypto = require('crypto');

const LINKEDIN_UGC_URL = 'https://api.linkedin.com/v2/ugcPosts';
/** Consumer "Share on LinkedIn" image flow — not rest/images + rest/posts (Marketing). */
const LINKEDIN_ASSETS_REGISTER_URL = 'https://api.linkedin.com/v2/assets?action=registerUpload';
const LINKEDIN_DOC_INIT_URL = 'https://api.linkedin.com/rest/documents?action=initializeUpload';
const LINKEDIN_REST_POSTS_URL = 'https://api.linkedin.com/rest/posts';
const LINKEDIN_API_VERSION = '202603';
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

async function checkRateLimit(userId, tenantId) {
  const windowParam = `${RATE_LIMIT_WINDOW_HOURS} hours`;

  const scheduledSql = `SELECT COUNT(*)::int AS cnt FROM scheduled_posts WHERE user_id = ? AND tenant_id = ? AND status = 'published' AND updated_at > (now() - ($3::text)::interval)`;

  const immediateSql = `SELECT COUNT(*)::int AS cnt FROM generated_posts WHERE user_id = ? AND tenant_id = ? AND status = 'published' AND published_at > (now() - ($3::text)::interval)`;

  const [{ cnt: scheduledCnt } = {}, { cnt: immediateCnt } = {}] = await Promise.all([
    db.prepare(scheduledSql).get(userId, tenantId, windowParam),
    db.prepare(immediateSql).get(userId, tenantId, windowParam),
  ]);

  if ((scheduledCnt ?? 0) > 0 || (immediateCnt ?? 0) > 0) {
    throw Object.assign(new Error('rate_limit_exceeded'), { statusCode: 429 });
  }
}

// ---------------------------------------------------------------------------
// Connection resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a linkedin_connections row for the workspace.
 * Priority: options.connectionId → options.profileId → workspace default profile's default connection.
 * Returns null if no matching connection is found.
 *
 * @param {string} tenantId  Workspace UUID
 * @param {{ connectionId?: number, profileId?: number }} [options]
 * @returns {Promise<object|null>}
 */
async function resolveConnection(tenantId, options = {}) {
  if (options.connectionId) {
    return db.prepare(
      'SELECT * FROM linkedin_connections WHERE id = ? AND workspace_id = ?'
    ).get(options.connectionId, tenantId);
  }

  // Workspace default personal connection
  return db.prepare(
    "SELECT * FROM linkedin_connections WHERE workspace_id = ? AND account_type = 'personal' AND is_default = true"
  ).get(tenantId);
}

// ---------------------------------------------------------------------------
// Token management — linkedin_connections
// ---------------------------------------------------------------------------

/**
 * Exchange a refresh token for new tokens and update ALL connections in the
 * workspace that share the same linkedin_member_id (personal + any org pages
 * connected by the same user).
 *
 * @param {object} connection  Row from linkedin_connections
 * @returns {Promise<string>}  New plaintext access token
 */
async function refreshConnectionToken(connection) {
  const clientId     = (process.env.LINKEDIN_CLIENT_ID || '').trim();
  const clientSecret = (process.env.LINKEDIN_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) throw new Error('linkedin_credentials_not_configured');
  if (!connection.refresh_token_enc) throw new Error('reconnect_required');

  const refreshToken = decrypt(connection.refresh_token_enc);

  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     clientId,
    client_secret: clientSecret,
  });

  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LinkedIn token refresh failed: ${res.status} ${text}`);
  }

  const tokens = await res.json();
  const newAccessTokenEnc  = encrypt(tokens.access_token);
  const newRefreshTokenEnc = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;
  const newExpiresAt = new Date(Date.now() + (tokens.expires_in || 5184000) * 1000).toISOString();

  if (connection.linkedin_member_id) {
    // Update all connections in the workspace sharing this member_id
    // (personal connection + any org pages that use the same underlying token)
    await db.prepare(`
      UPDATE linkedin_connections
      SET access_token_enc  = ?,
          refresh_token_enc = COALESCE(?, refresh_token_enc),
          expires_at        = ?,
          updated_at        = now()
      WHERE workspace_id = ? AND linkedin_member_id = ?
    `).run(newAccessTokenEnc, newRefreshTokenEnc, newExpiresAt,
           connection.workspace_id, connection.linkedin_member_id);
  } else {
    await db.prepare(`
      UPDATE linkedin_connections
      SET access_token_enc  = ?,
          refresh_token_enc = COALESCE(?, refresh_token_enc),
          expires_at        = ?,
          updated_at        = now()
      WHERE id = ?
    `).run(newAccessTokenEnc, newRefreshTokenEnc, newExpiresAt, connection.id);
  }

  return decrypt(newAccessTokenEnc);
}

/**
 * Return a valid plaintext access token for a connection, refreshing if within
 * 24 h of expiry. Throws 'reconnect_required' if the token cannot be refreshed.
 *
 * @param {object} connection  Row from linkedin_connections
 * @returns {Promise<string>}
 */
async function getValidConnectionToken(connection) {
  const expiresAt = new Date(connection.expires_at);
  const hoursUntilExpiry = (expiresAt - Date.now()) / 3_600_000;

  if (hoursUntilExpiry >= 24) {
    return decrypt(connection.access_token_enc);
  }

  if (!connection.refresh_token_enc) {
    await notifyWorkspaceReconnect(connection);
    throw new Error('reconnect_required');
  }

  try {
    return await refreshConnectionToken(connection);
  } catch (e) {
    console.warn(`[publisher] Token refresh failed for connection=${connection.id}:`, e.message);
    await notifyWorkspaceReconnect(connection);
    throw new Error('reconnect_required');
  }
}

/**
 * Create in-app and email reconnect notifications for every workspace member.
 * One notification per user at a time — deduped on an existing unread row.
 * Fire-and-forget — errors are swallowed.
 *
 * @param {object} connection  Row from linkedin_connections
 */
async function notifyWorkspaceReconnect(connection) {
  try {
    const members = await db.prepare(
      'SELECT user_id FROM workspace_members WHERE workspace_id = ?'
    ).all(connection.workspace_id);

    const connName = connection.display_name || 'your LinkedIn account';
    const appUrl   = process.env.APP_URL || '';

    for (const m of members) {
      try {
        const existing = await db.prepare(`
          SELECT id FROM notifications
          WHERE user_id = ? AND tenant_id = ? AND type = 'reconnect_required' AND read_at IS NULL
          LIMIT 1
        `).get(m.user_id, connection.workspace_id);
        if (existing) continue;

        await db.prepare(`
          INSERT INTO notifications (user_id, tenant_id, type, title, body, ref_type)
          VALUES (?, ?, 'reconnect_required', 'LinkedIn reconnection needed', ?, 'linkedin_connection')
        `).run(
          m.user_id,
          connection.workspace_id,
          `The LinkedIn connection for "${connName}" has expired. Please reconnect to continue publishing.`
        );

        sendEmailToUser(m.user_id, 'linkedin-reconnect', { app_url: appUrl },
          { dedupKey: `reconnect_${connection.workspace_id}_${connection.id}`, withinHours: 24 });
      } catch { /* per-member errors are non-fatal */ }
    }
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Core LinkedIn publish helpers
// ---------------------------------------------------------------------------

/**
 * Register a feed-share image upload (consumer API).
 * Returns digitalmediaAsset URN + upload URL.
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
    if (res.status === 426) throw new Error('linkedin_api_version_error');
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

async function uploadFeedshareImageBinary(accessToken, uploadUrl, buffer, extraHeaders = {}, contentType = 'image/jpeg') {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': contentType,
      ...extraHeaders,
    },
    body: buffer,
  });

  if (!res.ok) {
    if (res.status === 426) throw new Error('linkedin_api_version_error');
    const text = await res.text();
    throw new Error(`LinkedIn feedshare image upload error ${res.status}: ${text}`);
  }
}

/**
 * UGC post with image — uses urn:li:digitalmediaAsset from v2/assets (consumer flow).
 * @param {string} ownerUrn  Full author URN: urn:li:person:ID or urn:li:organization:ID
 */
async function createUgcPostWithImage(accessToken, ownerUrn, content, assetUrn) {
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
    if (res.status === 426) throw new Error('linkedin_api_version_error');
    const text = await res.text();
    throw new Error(`LinkedIn API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.id;
}

/**
 * Text-only organic post (legacy UGC endpoint).
 * @param {string} ownerUrn  Full author URN: urn:li:person:ID or urn:li:organization:ID
 */
async function callLinkedInAPI(accessToken, ownerUrn, content) {
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
    if (res.status === 426) throw new Error('linkedin_api_version_error');
    const text = await res.text();
    throw new Error(`LinkedIn API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.id;
}

/**
 * REST post with media (carousel/document).
 * @param {string} ownerUrn  Full author URN: urn:li:person:ID or urn:li:organization:ID
 */
async function createRestPostWithMedia(accessToken, ownerUrn, commentary, mediaPayload) {
  const body = {
    author: ownerUrn,
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
    if (res.status === 426) throw new Error('linkedin_api_version_error');
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

  if (!filename || filename !== path.basename(filename)) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) return null;

  try {
    return await storage.download(storage.buildMemberKey(tenantId, userId, type, filename));
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
    if (res.status === 426) throw new Error('linkedin_api_version_error');
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
    if (res.status === 426) throw new Error('linkedin_api_version_error');
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
 *
 * Connection resolution priority:
 *   options.connectionId → options.profileId → workspace default connection
 *
 * @param {string} userId       For rate-limit check only
 * @param {string} tenantId     Workspace UUID
 * @param {string} content
 * @param {{ connectionId?: number, profileId?: number, image_url?: string, carousel_pdf_url?: string }} [options]
 * @returns {Promise<{ linkedin_post_id: string }>}
 */
async function publishNow(userId, tenantId, content, options = {}) {
  // Rate limit — 1 post/hour
  await checkRateLimit(userId, tenantId);

  // Resolve which LinkedIn connection to use
  const connection = await resolveConnection(tenantId, options);
  if (!connection) throw new Error('not_connected');

  // Get a valid (possibly refreshed) access token
  const accessToken = await getValidConnectionToken(connection);

  // Build the author URN — person or organisation
  const ownerUrn = connection.account_type === 'company'
    ? `urn:li:organization:${connection.organization_id}`
    : `urn:li:person:${connection.linkedin_member_id}`;

  if (options.carousel_pdf_url) {
    const pdfBytes = await readStoredFileBytes(options.carousel_pdf_url, userId, tenantId);
    if (!pdfBytes) throw new Error('invalid_carousel_pdf_url');

    const { uploadUrl, document } = await initializeDocumentUpload(accessToken, ownerUrn);
    await uploadDocumentPdf(accessToken, uploadUrl, pdfBytes);
    await waitForDocumentAvailable(accessToken, document);
    const linkedin_post_id = await createRestPostWithMedia(accessToken, ownerUrn, content, {
      title: 'Carousel.pdf',
      id: document,
    });
    return { linkedin_post_id };
  }

  if (options.image_url) {
    const bytes = await readStoredFileBytes(options.image_url, userId, tenantId);
    if (!bytes) throw new Error('invalid_image_url');

    const ext = path.extname(options.image_url).toLowerCase();
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    const imageMime = mimeMap[ext] || 'image/png';

    const { asset, uploadUrl, uploadHeaders } = await registerFeedshareImageUpload(accessToken, ownerUrn);
    await uploadFeedshareImageBinary(accessToken, uploadUrl, bytes, uploadHeaders, imageMime);
    await sleep(2000);
    const linkedin_post_id = await createUgcPostWithImage(accessToken, ownerUrn, content, asset);
    return { linkedin_post_id };
  }

  const linkedin_post_id = await callLinkedInAPI(accessToken, ownerUrn, content);
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
  'linkedin_api_version_error',
]);

/**
 * BullMQ job handler — publish a scheduled post.
 *
 * For transient failures (LinkedIn 429, network errors) the function resets
 * the row to 'pending' and throws so BullMQ retries with exponential backoff.
 * For non-retriable errors it marks the row 'not_sent' without throwing.
 *
 * @param {number} scheduledPostId
 * @param {{ attemptsMade: number, maxAttempts: number }} [attemptInfo]
 */
async function publishScheduledPost(scheduledPostId, { attemptsMade = 0, maxAttempts = 3 } = {}) {
  const isFinalAttempt = (attemptsMade + 1) >= maxAttempts;

  // capturedTenantId is set as soon as we fetch `current` so that all
  // subsequent UPDATE statements carry the tenant guard (Trap 16 defence-in-depth).
  let capturedTenantId = null;

  try {
    const current = await db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(scheduledPostId);
    if (!current) {
      console.log(`[publisher] scheduledPostId=${scheduledPostId} not found — skipping`);
      return;
    }
    capturedTenantId = current.tenant_id;

    if (!['pending', 'processing'].includes(current.status)) {
      console.log(`[publisher] scheduledPostId=${scheduledPostId} status=${current.status} — skipping`);
      return;
    }

    if (current.status === 'published' || current.linkedin_post_id) {
      console.log(`[publisher] scheduledPostId=${scheduledPostId} already published — skipping`);
      return;
    }

    // Workspace-active guard (Trap 3): do not publish for deleted or grace-period workspaces.
    const ws = await db.prepare(
      'SELECT deleted_at, grace_expires_at FROM workspaces WHERE id = ?'
    ).get(current.tenant_id);
    if (!ws || ws.deleted_at || ws.grace_expires_at) {
      await db.prepare(`
        UPDATE scheduled_posts
        SET status = 'cancelled', error_message = 'workspace_inactive', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND tenant_id = ?
      `).run(scheduledPostId, current.tenant_id);
      console.log(`[publisher] scheduledPostId=${scheduledPostId} cancelled — workspace inactive (tenant=${current.tenant_id})`);
      return;
    }

    // Claim the job if it's pending. Includes tenant guard so a stale job from
    // another workspace cannot be accidentally claimed across tenants.
    if (current.status === 'pending') {
      const claim = await db.prepare(`
        UPDATE scheduled_posts
        SET status = 'processing',
            attempts = attempts + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending' AND tenant_id = ?
      `).run(scheduledPostId, current.tenant_id);

      if (claim.changes === 0) {
        console.log(`[publisher] scheduledPostId=${scheduledPostId} could not be claimed — skipping`);
        return;
      }
    }

    // Re-fetch after claiming to get updated attempts/status.
    const row = await db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(scheduledPostId);
    if (!row || row.status !== 'processing') {
      console.log(`[publisher] scheduledPostId=${scheduledPostId} not processing — skipping`);
      return;
    }
    capturedTenantId = row.tenant_id; // keep in sync

    // Integrity check: ensure the scheduled payload hasn't been mutated.
    if (row.payload_hash) {
      const computed = sha256Hex(JSON.stringify({
        content: row.content,
        asset_type: row.asset_type || null,
        asset_url: row.asset_url || null,
        scheduled_for: row.scheduled_for,
        first_comment: row.first_comment || null,
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

    // Build publish options: asset type + profile/connection context
    const publishOpts = {};
    if (row.asset_type === 'carousel' && row.asset_url) {
      publishOpts.carousel_pdf_url = row.asset_url;
    } else if (row.asset_type === 'image' && row.asset_url) {
      publishOpts.image_url = row.asset_url;
    }
    // Idempotency guard: skip the API call if a linkedin_post_id was already
    // persisted by a previous attempt that failed after the API call.
    let linkedin_post_id = row.linkedin_post_id || null;
    if (linkedin_post_id) {
      console.log(`[publisher] scheduledPostId=${scheduledPostId} linkedin_post_id already set (${linkedin_post_id}) — skipping API call`);
    } else {
      ({ linkedin_post_id } = await publishNow(row.user_id, row.tenant_id, row.content, publishOpts));
    }

    await db.prepare(`
      UPDATE scheduled_posts SET status = 'published', linkedin_post_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND tenant_id = ?
    `).run(linkedin_post_id, scheduledPostId, row.tenant_id);

    // Affiliate milestone bonus check (fire-and-forget)
    require('./affiliates').checkMilestoneBonus(row.user_id).catch(() => {});

    try {
      await db.prepare(`
        INSERT INTO scheduled_post_events (scheduled_post_id, user_id, tenant_id, event_type, message)
        VALUES (?, ?, ?, 'published', ?)
      `).run(scheduledPostId, row.user_id, row.tenant_id, linkedin_post_id);
    } catch { /* non-fatal */ }

    // Enqueue first comment job if the user scheduled one (fires 60s later).
    if (row.first_comment) {
      try {
        const { addCommentJob } = require('./scheduler');
        await addCommentJob(scheduledPostId);
      } catch (e) {
        console.warn(`[publisher] scheduledPostId=${scheduledPostId} failed to enqueue comment job:`, e.message);
      }
    }

    // Stamp the originating draft as published, including the linkedin_post_id.
    if (row.post_id) {
      await db.prepare(`
        UPDATE generated_posts
        SET status = 'published', published_at = CURRENT_TIMESTAMP, linkedin_post_id = ?
        WHERE id = ? AND user_id = ? AND tenant_id = ?
      `).run(linkedin_post_id, row.post_id, row.user_id, row.tenant_id);

      // Trial email — evaluate immediately after first publish (no settle needed)
      require('./trialEmails').evaluateAndSend(row.user_id, row.tenant_id).catch(() => {});

      // Track archetype preference for hook bias (fire-and-forget)
      try {
        const postRow = await db.prepare('SELECT archetype_used, profile_id FROM generated_posts WHERE id = ?')
          .get(row.post_id);
        const profileId = postRow?.profile_id ?? row.profile_id;
        if (postRow?.archetype_used && profileId) {
          const prefRow = await db.prepare(
            'SELECT user_archetype_preference FROM profiles WHERE id = ?'
          ).get(profileId);
          const prefs = (() => {
            try { return prefRow?.user_archetype_preference ? JSON.parse(prefRow.user_archetype_preference) : {}; }
            catch { return {}; }
          })();
          prefs[postRow.archetype_used] = (prefs[postRow.archetype_used] || 0) + 1;
          await db.prepare('UPDATE profiles SET user_archetype_preference = ? WHERE id = ?')
            .run(JSON.stringify(prefs), profileId);
        }
      } catch { /* non-fatal */ }
    }

    // In-app notification
    try {
      await db.prepare(`
        INSERT INTO notifications (user_id, tenant_id, type, title, body, ref_id, ref_type)
        VALUES (?, ?, 'publish_succeeded', 'Post published', ?, ?, 'scheduled_post')
      `).run(
        row.user_id,
        row.tenant_id,
        'Your scheduled post has been published to LinkedIn.',
        scheduledPostId
      );
    } catch { /* non-fatal */ }

    // Email notification
    try {
      const appUrl = process.env.APP_URL || '';
      const postPreview = (row.content || '').slice(0, 120) + ((row.content || '').length > 120 ? '…' : '');
      const shareId = String(linkedin_post_id || '').split(':').pop();
      const linkedinPostUrl = shareId
        ? `https://www.linkedin.com/feed/update/${linkedin_post_id}/`
        : `${appUrl}/generate.html`;
      sendEmailToUser(row.user_id, 'post-published', {
        post_preview: postPreview,
        linkedin_post_url: linkedinPostUrl,
        app_url: appUrl,
      }, { dedupKey: false });
    } catch { /* non-fatal */ }

    console.log(`[publisher] scheduledPostId=${scheduledPostId} published as ${linkedin_post_id}`);
  } catch (err) {
    const isNonRetriable = NON_RETRIABLE_ERRORS.has(err.message) || isFinalAttempt;

    if (isNonRetriable) {
      let markOk = false;
      for (let i = 0; i < 3 && !markOk; i++) {
        try {
          if (i > 0) await new Promise(r => setTimeout(r, 2000));
          const updateResult = await db.prepare(`
            UPDATE scheduled_posts
            SET status = 'not_sent', error_message = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status IN ('pending', 'processing')
              AND tenant_id = ?
          `).run(err.message, scheduledPostId, capturedTenantId);
          // Fall back without tenant guard if we somehow lost capturedTenantId
          if (updateResult.changes === 0 && !capturedTenantId) {
            await db.prepare(`
              UPDATE scheduled_posts
              SET status = 'not_sent', error_message = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND status IN ('pending', 'processing')
            `).run(err.message, scheduledPostId);
          }
          markOk = true;
        } catch (dbErr) {
          console.error(`[publisher] scheduledPostId=${scheduledPostId} not_sent UPDATE failed (attempt ${i + 1}/3):`, dbErr.message);
        }
      }
      if (!markOk) {
        throw new Error(`not_sent_db_write_failed: ${err.message}`);
      }

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

      // Failure notification
      try {
        const meta = await db.prepare('SELECT user_id, tenant_id, content, scheduled_for FROM scheduled_posts WHERE id = ?').get(scheduledPostId);
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

          const appUrl = process.env.APP_URL || '';
          const postPreview = (meta.content || '').slice(0, 120) + ((meta.content || '').length > 120 ? '…' : '');
          const scheduledFor = meta.scheduled_for
            ? new Date(meta.scheduled_for).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
            : 'the scheduled time';
          const errorReasonMap = {
            reconnect_required:                  'Your LinkedIn connection has expired — please reconnect.',
            not_connected:                       'Your LinkedIn account is not connected.',
            rate_limit_exceeded:                 'You reached LinkedIn\'s posting rate limit (1 post/hour).',
            invalid_image_url:                   'The attached image could not be accessed.',
            invalid_carousel_pdf_url:            'The carousel PDF could not be accessed.',
            linkedin_document_processing_failed: 'LinkedIn couldn\'t process the carousel document.',
            linkedin_document_not_ready:         'LinkedIn timed out while processing the carousel document.',
            linkedin_api_version_error:          'A LinkedIn API version issue occurred — the post has been queued for retry after an update.',
            workspace_inactive:                  'This workspace is no longer active.',
          };
          const errorReason = errorReasonMap[err.message] || err.message || 'An unexpected error occurred.';
          sendEmailToUser(meta.user_id, 'post-failed', {
            scheduled_for: scheduledFor,
            error_reason: errorReason,
            post_preview: postPreview,
            app_url: appUrl,
          }, { dedupKey: false });
        }
      } catch { /* non-fatal */ }

      console.warn(`[publisher] scheduledPostId=${scheduledPostId} not_sent (final):`, err.message);
      // Do not throw — BullMQ should not retry non-retriable failures.
    } else {
      // Transient failure — reset to pending so the next BullMQ attempt can claim it.
      try {
        await db.prepare(`
          UPDATE scheduled_posts
          SET status = 'pending', error_message = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'processing' AND tenant_id = ?
        `).run(err.message, scheduledPostId, capturedTenantId);
      } catch (dbErr) {
        console.error(`[publisher] scheduledPostId=${scheduledPostId} pending reset failed:`, dbErr.message);
      }

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
      throw err;
    }
  }
}

/**
 * Post the first comment on a published post. Called by the BullMQ 'post-comment' job
 * 60 seconds after the post goes live.
 */
async function publishFirstComment(scheduledPostId) {
  const row = await db.prepare(
    'SELECT linkedin_post_id, first_comment, first_comment_status, user_id, tenant_id, profile_id FROM scheduled_posts WHERE id = ?'
  ).get(scheduledPostId);

  if (!row?.first_comment || !row?.linkedin_post_id) return;
  // Already resolved on a previous attempt — skip to avoid spamming LinkedIn API on retries.
  if (row.first_comment_status === 'posted' || row.first_comment_status === 'failed') return;

  const conn = await resolveConnection(row.tenant_id);
  if (!conn) {
    await db.prepare(
      "UPDATE scheduled_posts SET first_comment_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?"
    ).run(scheduledPostId, row.tenant_id);
    return;
  }

  let accessToken;
  try {
    accessToken = await getValidConnectionToken(conn);
  } catch {
    await db.prepare(
      "UPDATE scheduled_posts SET first_comment_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?"
    ).run(scheduledPostId, row.tenant_id);
    return;
  }

  const actorUrn = conn.account_type === 'company'
    ? `urn:li:organization:${conn.organization_id}`
    : `urn:li:person:${conn.linkedin_member_id}`;

  const shareUrn = row.linkedin_post_id;

  const res = await fetch(
    `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(shareUrn)}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'LinkedIn-Version': LINKEDIN_API_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify({
        actor: actorUrn,
        message: { text: row.first_comment },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[publisher] first comment failed for scheduledPostId=${scheduledPostId}: ${res.status} ${errText}`);
    await db.prepare(
      "UPDATE scheduled_posts SET first_comment_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?"
    ).run(scheduledPostId, row.tenant_id);
    // Do not throw — the status is persisted and the guard above prevents retries.
    return;
  }

  await db.prepare(
    "UPDATE scheduled_posts SET first_comment_status = 'posted', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?"
  ).run(scheduledPostId, row.tenant_id);

  try {
    await db.prepare(
      "INSERT INTO scheduled_post_events (scheduled_post_id, user_id, tenant_id, event_type) VALUES (?, ?, ?, 'first_comment_posted')"
    ).run(scheduledPostId, row.user_id, row.tenant_id);
  } catch { /* non-fatal */ }

  console.log(`[publisher] scheduledPostId=${scheduledPostId} first comment posted`);
}

module.exports = { publishNow, publishScheduledPost, publishFirstComment };

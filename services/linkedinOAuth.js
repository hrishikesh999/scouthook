'use strict';

const crypto = require('crypto');
const { db, getSettingSync } = require('../db');
const { sendEmailToUser } = require('../emails');

// ---------------------------------------------------------------------------
// Reconnect notifications — sent to ALL workspace members
// ---------------------------------------------------------------------------

/**
 * Create an in-app reconnect notification for a user in a workspace.
 * Deduped: only one unread notification per user + workspace at a time.
 * Also sends a reconnect email (deduplicated to once per 24 h).
 *
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string|null} [connectionName]  Display name of the expired connection
 */
async function createReconnectNotification(userId, workspaceId, connectionName = null) {
  try {
    const existing = await db.prepare(`
      SELECT id FROM notifications
      WHERE user_id = ? AND tenant_id = ? AND type = 'reconnect_required' AND read_at IS NULL
      LIMIT 1
    `).get(userId, workspaceId);
    if (existing) return;

    const body = connectionName
      ? `The LinkedIn connection for "${connectionName}" has expired. Please reconnect to continue publishing.`
      : 'Your LinkedIn connection has expired. Please reconnect to continue publishing.';

    await db.prepare(`
      INSERT INTO notifications (user_id, tenant_id, type, title, body, ref_type)
      VALUES (?, ?, 'reconnect_required', 'LinkedIn reconnection needed', ?, 'linkedin_connection')
    `).run(userId, workspaceId, body);

    const appUrl = process.env.APP_URL || '';
    sendEmailToUser(userId, 'linkedin-reconnect', { app_url: appUrl },
      { dedupKey: `reconnect_${workspaceId}`, withinHours: 24 });
  } catch { /* non-fatal */ }
}

/**
 * Notify every member of a workspace that a LinkedIn connection needs reconnecting.
 * Fire-and-forget.
 *
 * @param {string} workspaceId
 * @param {string|null} [connectionName]
 */
async function notifyAllWorkspaceMembersReconnect(workspaceId, connectionName = null) {
  try {
    const members = await db.prepare(
      'SELECT user_id FROM workspace_members WHERE workspace_id = ?'
    ).all(workspaceId);
    for (const m of members) {
      await createReconnectNotification(m.user_id, workspaceId, connectionName);
    }
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// AES-256-GCM encryption helpers
// Storage format: iv_hex:authTag_hex:ciphertext_hex
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV — recommended for GCM

function getEncryptionKey() {
  const key = (process.env.TOKEN_ENCRYPTION_KEY || '').trim() || getSettingSync('token_encryption_key');
  if (!key) throw new Error('token_encryption_key not set in platform_settings');
  if (key.length !== 64) throw new Error('token_encryption_key must be a 64-char hex string (32 bytes)');
  return Buffer.from(key, 'hex');
}

function encrypt(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decrypt(encryptedStr) {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, ctHex] = encryptedStr.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ctHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Token retrieval — reads from linkedin_connections
// ---------------------------------------------------------------------------

/**
 * Return a valid plaintext access token for a workspace, refreshing automatically
 * if within 24 h of expiry.
 *
 * Resolves in order: workspaceId → default personal connection's token.
 * Notifies ALL workspace members if reconnection is needed.
 *
 * @param {string} workspaceId
 * @returns {Promise<string>} plaintext access token
 */
async function getValidAccessToken(workspaceId) {
  const row = await db.prepare(`
    SELECT * FROM linkedin_connections
    WHERE workspace_id = ? AND account_type = 'personal' AND is_default = true
  `).get(workspaceId);

  if (!row) throw new Error('not_connected');

  // Checked before expiry: a revoked token keeps a healthy-looking expires_at, so
  // the date alone never reveals it. See linkedinHealth for how the flag is set.
  if (row.needs_reconnect_at) throw new Error('reconnect_required');

  const expiresAt = new Date(row.expires_at);
  const hoursUntilExpiry = (expiresAt - Date.now()) / 3_600_000;

  if (hoursUntilExpiry >= 24) {
    return decrypt(row.access_token_enc);
  }

  const { markConnectionDead } = require('./linkedinHealth');

  if (!row.refresh_token_enc) {
    await markConnectionDead(row, 'no_refresh_token');
    throw new Error('reconnect_required');
  }

  try {
    const newToken = await refreshConnectionToken(row);
    return newToken;
  } catch {
    await markConnectionDead(row, 'refresh_failed');
    throw new Error('reconnect_required');
  }
}

// ---------------------------------------------------------------------------
// Profile photo — re-fetch the current LinkedIn CDN photo URL
// ---------------------------------------------------------------------------

/**
 * Fetch the member's current profile photo URL from the OpenID userinfo
 * endpoint. LinkedIn CDN photo URLs are time-limited signed URLs that expire
 * independently of the OAuth token, so we re-pull a fresh one whenever we
 * refresh the token. Best-effort — returns null on any failure so callers can
 * COALESCE and leave the stored URL untouched.
 *
 * @param {string} accessToken  Plaintext access token
 * @returns {Promise<string|null>}
 */
async function fetchLinkedInPhotoUrl(accessToken) {
  try {
    const res = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      console.warn('[linkedinOAuth] userinfo photo re-fetch failed:', res.status);
      return null;
    }
    const profile = await res.json();
    return profile.picture || null;
  } catch (e) {
    console.warn('[linkedinOAuth] userinfo photo re-fetch error (non-fatal):', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Profile photo caching — mirror the CDN image into our own storage
// ---------------------------------------------------------------------------

const AVATAR_MAX_BYTES = 3 * 1024 * 1024; // 3 MB ceiling — profile photos are tiny
const AVATAR_EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/gif':  'gif',
};

/**
 * Download a LinkedIn CDN photo and mirror it into our own storage so the app
 * never depends on the CDN URL staying valid. Filename is derived from a stable
 * member key, so re-caching the same member overwrites in place (no orphans).
 *
 * Best-effort — returns null on any failure (bad URL, non-image, oversize,
 * network error) so callers can fall back to the raw remote URL.
 *
 * @param {string} remoteUrl  A LinkedIn media.licdn.com photo URL
 * @param {string} memberKey  Stable identifier (linkedin_member_id or account_key)
 * @returns {Promise<string|null>}  A stable app-relative URL, e.g. '/linkedin-avatar/<hash>.jpg'
 */
async function cacheLinkedInAvatar(remoteUrl, memberKey) {
  if (!remoteUrl || !memberKey) return null;
  const storage = require('./storage');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
      res = await fetch(remoteUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      console.warn('[linkedinOAuth] avatar download failed:', res.status);
      return null;
    }

    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = AVATAR_EXT_BY_TYPE[contentType];
    if (!ext) {
      console.warn('[linkedinOAuth] avatar has non-image content-type:', contentType || '(none)');
      return null;
    }

    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    if (buffer.length === 0 || buffer.length > AVATAR_MAX_BYTES) {
      console.warn('[linkedinOAuth] avatar size out of bounds:', buffer.length);
      return null;
    }

    const hash = crypto.createHash('sha256').update(String(memberKey), 'utf8').digest('hex').slice(0, 32);
    const filename = `${hash}.${ext}`;
    await storage.uploadToKey(buffer, storage.buildLinkedInAvatarKey(filename), contentType === 'image/jpg' ? 'image/jpeg' : contentType);
    return `/linkedin-avatar/${filename}`;
  } catch (e) {
    console.warn('[linkedinOAuth] avatar cache error (non-fatal):', e.message);
    return null;
  }
}

const AVATAR_MIME_BY_EXT = {
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
  gif:  'image/gif',
};

/**
 * Resolve a stored avatar_url (either a cached '/linkedin-avatar/<hash>.jpg' path
 * or a raw remote CDN URL) into a base64 data URI for server-side embedding
 * (e.g. Satori visual rendering). Cached avatars are read directly from storage;
 * remote URLs are fetched over HTTP. Best-effort — returns null on any failure.
 *
 * @param {string} avatarUrl
 * @returns {Promise<string|null>}  data:image/...;base64,... or null
 */
async function loadLinkedInAvatarDataUri(avatarUrl) {
  if (!avatarUrl) return null;
  const url = avatarUrl.trim();
  try {
    const cached = url.match(/^\/linkedin-avatar\/([0-9a-f]{1,64}\.(?:jpg|jpeg|png|gif|webp))$/i);
    if (cached) {
      const storage = require('./storage');
      const filename = cached[1];
      const buf = await storage.download(storage.buildLinkedInAvatarKey(filename));
      const ext = filename.split('.').pop().toLowerCase();
      const mime = AVATAR_MIME_BY_EXT[ext] || 'image/jpeg';
      return `data:${mime};base64,${buf.toString('base64')}`;
    }
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
  } catch (e) {
    console.warn('[linkedinOAuth] loadLinkedInAvatarDataUri failed (non-fatal):', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token refresh — writes back to linkedin_connections
// ---------------------------------------------------------------------------

/**
 * Exchange a refresh token for new tokens and update ALL connections sharing
 * the same linkedin_member_id in the workspace. Also re-pulls the profile
 * photo URL so it never ages out while the connection stays active.
 *
 * @param {object} connection  Row from linkedin_connections
 * @returns {Promise<string>}  New plaintext access token
 */
async function refreshConnectionToken(connection) {
  const clientId     = (process.env.LINKEDIN_CLIENT_ID || '').trim();
  const clientSecret = (process.env.LINKEDIN_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) throw new Error('linkedin_credentials_not_configured');

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

  // Re-pull a fresh CDN photo URL for personal accounts only (null on failure or
  // for org pages → leaves the stored URL / org logo intact), then mirror it into
  // our own storage so avatar_url points at a stable, non-expiring app URL.
  let freshPhoto = null;
  if (connection.account_type === 'personal') {
    const remotePhoto = await fetchLinkedInPhotoUrl(tokens.access_token);
    if (remotePhoto) {
      const memberKey = connection.linkedin_member_id || connection.account_key;
      freshPhoto = (await cacheLinkedInAvatar(remotePhoto, memberKey)) || remotePhoto;
    }
  }

  if (connection.linkedin_member_id) {
    // Update all connections in this workspace sharing the same member_id.
    // Only personal connections carry a member_id, so refreshing avatar_url here
    // never clobbers org-page logos (those rows have linkedin_member_id = NULL).
    await db.prepare(`
      UPDATE linkedin_connections
      SET access_token_enc  = ?,
          refresh_token_enc = COALESCE(?, refresh_token_enc),
          expires_at        = ?,
          avatar_url        = COALESCE(?, avatar_url),
          updated_at        = now()
      WHERE workspace_id = ? AND linkedin_member_id = ?
    `).run(newAccessTokenEnc, newRefreshTokenEnc, newExpiresAt, freshPhoto,
           connection.workspace_id, connection.linkedin_member_id);
  } else {
    await db.prepare(`
      UPDATE linkedin_connections
      SET access_token_enc  = ?,
          refresh_token_enc = COALESCE(?, refresh_token_enc),
          expires_at        = ?,
          avatar_url        = COALESCE(?, avatar_url),
          updated_at        = now()
      WHERE id = ?
    `).run(newAccessTokenEnc, newRefreshTokenEnc, newExpiresAt, freshPhoto, connection.id);
  }

  return decrypt(newAccessTokenEnc);
}

// ---------------------------------------------------------------------------
// Token revocation
// ---------------------------------------------------------------------------

/**
 * Revoke all personal LinkedIn access tokens for a workspace.
 * Best-effort — logs warnings on failure but never throws.
 * Must be called before deleting connection rows from the DB.
 *
 * @param {string} workspaceId
 */
async function revokeLinkedInToken(workspaceId) {
  const rows = await db.prepare(`
    SELECT id, access_token_enc, linkedin_member_id
    FROM   linkedin_connections
    WHERE  workspace_id = ? AND account_type = 'personal'
  `).all(workspaceId);
  if (!rows.length) return;

  const clientId     = (process.env.LINKEDIN_CLIENT_ID || '').trim();
  const clientSecret = (process.env.LINKEDIN_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    console.warn('[linkedinOAuth] revokeLinkedInToken: credentials not configured, skipping revocation');
    return;
  }

  const revokedMemberIds = new Set();
  for (const row of rows) {
    if (row.linkedin_member_id && revokedMemberIds.has(row.linkedin_member_id)) continue;
    try {
      const accessToken = decrypt(row.access_token_enc);
      const params = new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        token:         accessToken,
      });
      const res = await fetch('https://www.linkedin.com/oauth/v2/revoke', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    params.toString(),
      });
      if (!res.ok) {
        const text = await res.text();
        console.warn(`[linkedinOAuth] Token revocation returned ${res.status}: ${text}`);
      } else {
        console.log(`[linkedinOAuth] Token revoked for workspace=${workspaceId}, member=${row.linkedin_member_id}`);
      }
      if (row.linkedin_member_id) revokedMemberIds.add(row.linkedin_member_id);
    } catch (err) {
      console.warn('[linkedinOAuth] Token revocation failed (non-fatal):', err.message);
    }
  }
}

module.exports = {
  encrypt,
  decrypt,
  getValidAccessToken,
  revokeLinkedInToken,
  createReconnectNotification,
  notifyAllWorkspaceMembersReconnect,
  fetchLinkedInPhotoUrl,
  cacheLinkedInAvatar,
  loadLinkedInAvatarDataUri,
};

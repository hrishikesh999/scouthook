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

  const expiresAt = new Date(row.expires_at);
  const hoursUntilExpiry = (expiresAt - Date.now()) / 3_600_000;

  if (hoursUntilExpiry >= 24) {
    return decrypt(row.access_token_enc);
  }

  if (!row.refresh_token_enc) {
    await notifyAllWorkspaceMembersReconnect(workspaceId, row.display_name);
    throw new Error('reconnect_required');
  }

  try {
    const newToken = await refreshConnectionToken(row);
    return newToken;
  } catch {
    await notifyAllWorkspaceMembersReconnect(workspaceId, row.display_name);
    throw new Error('reconnect_required');
  }
}

// ---------------------------------------------------------------------------
// Token refresh — writes back to linkedin_connections
// ---------------------------------------------------------------------------

/**
 * Exchange a refresh token for new tokens and update ALL connections sharing
 * the same linkedin_member_id in the workspace.
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

  if (connection.linkedin_member_id) {
    // Update all connections in this workspace sharing the same member_id
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
};

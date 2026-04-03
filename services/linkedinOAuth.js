'use strict';

const crypto = require('crypto');
const { db, getSetting } = require('../db');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV — recommended for GCM

// ---------------------------------------------------------------------------
// Encryption helpers — AES-256-GCM, key from platform_settings
// Storage format: iv_hex:authTag_hex:ciphertext_hex
// ---------------------------------------------------------------------------

function getEncryptionKey() {
  const key = getSetting('token_encryption_key');
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
// Token storage
// ---------------------------------------------------------------------------

/**
 * Encrypt and upsert LinkedIn tokens into linkedin_tokens.
 * @param {string} userId
 * @param {string} tenantId
 * @param {{ access_token, refresh_token?, expires_in, linkedin_user_id, linkedin_name, linkedin_photo? }} tokenData
 */
function storeTokens(userId, tenantId, tokenData) {
  const {
    access_token,
    refresh_token,
    expires_in,
    linkedin_user_id,
    linkedin_name,
    linkedin_photo = null,
  } = tokenData;

  const accessTokenEnc  = encrypt(access_token);
  const refreshTokenEnc = refresh_token ? encrypt(refresh_token) : null;
  const expiresAt = new Date(Date.now() + (expires_in || 5184000) * 1000).toISOString(); // default 60 days

  db.prepare(`
    INSERT INTO linkedin_tokens
      (user_id, tenant_id, access_token_enc, refresh_token_enc, expires_at, linkedin_user_id, linkedin_name, linkedin_photo, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, tenant_id) DO UPDATE SET
      access_token_enc  = excluded.access_token_enc,
      refresh_token_enc = COALESCE(excluded.refresh_token_enc, refresh_token_enc),
      expires_at        = excluded.expires_at,
      linkedin_user_id  = excluded.linkedin_user_id,
      linkedin_name     = excluded.linkedin_name,
      linkedin_photo    = COALESCE(excluded.linkedin_photo, linkedin_photo),
      updated_at        = CURRENT_TIMESTAMP
  `).run(userId, tenantId, accessTokenEnc, refreshTokenEnc, expiresAt, linkedin_user_id, linkedin_name, linkedin_photo);
}

// ---------------------------------------------------------------------------
// Token retrieval
// ---------------------------------------------------------------------------

/**
 * Return a valid plaintext access token, refreshing automatically if within 24h of expiry.
 * @param {string} userId
 * @param {string} tenantId
 * @returns {Promise<string>} plaintext access token
 */
async function getValidAccessToken(userId, tenantId) {
  const row = db.prepare(
    'SELECT * FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
  ).get(userId, tenantId);

  if (!row) throw new Error('not_connected');

  const expiresAt = new Date(row.expires_at);
  const hoursUntilExpiry = (expiresAt - Date.now()) / 3_600_000;

  if (hoursUntilExpiry < 24) {
    if (!row.refresh_token_enc) throw new Error('reconnect_required');
    try {
      await refreshLinkedInToken(userId, tenantId, row.refresh_token_enc);
      // Re-fetch the updated row
      const updated = db.prepare(
        'SELECT access_token_enc FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
      ).get(userId, tenantId);
      return decrypt(updated.access_token_enc);
    } catch {
      throw new Error('reconnect_required');
    }
  }

  return decrypt(row.access_token_enc);
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/**
 * Exchange a refresh token for new tokens and update the DB row.
 * @param {string} userId
 * @param {string} tenantId
 * @param {string} encryptedRefreshToken
 */
async function refreshLinkedInToken(userId, tenantId, encryptedRefreshToken) {
  const clientId     = getSetting('linkedin_client_id');
  const clientSecret = getSetting('linkedin_client_secret');
  if (!clientId || !clientSecret) throw new Error('linkedin_credentials_not_configured');

  const refreshToken = decrypt(encryptedRefreshToken);

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

  // Keep existing linkedin_user_id / linkedin_name — only tokens change on refresh
  const existing = db.prepare(
    'SELECT linkedin_user_id, linkedin_name, linkedin_photo FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
  ).get(userId, tenantId);

  storeTokens(userId, tenantId, {
    access_token:    tokens.access_token,
    refresh_token:   tokens.refresh_token || null,
    expires_in:      tokens.expires_in,
    linkedin_user_id: existing?.linkedin_user_id,
    linkedin_name:    existing?.linkedin_name,
    linkedin_photo:   existing?.linkedin_photo,
  });
}

module.exports = { encrypt, decrypt, storeTokens, getValidAccessToken, refreshLinkedInToken };

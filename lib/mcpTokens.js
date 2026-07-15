'use strict';

const crypto = require('crypto');
const { db } = require('../db');

// Personal access tokens for the ScoutHook MCP server (see docs/mcp-server-plan.md).
// Raw token shape: shk_mcp_<43 base64url chars>. Only the SHA-256 hash is stored,
// so a leaked database row cannot be replayed against the endpoint.

const TOKEN_PREFIX = 'shk_mcp_';
const PREFIX_STORE_LEN = TOKEN_PREFIX.length + 6; // shk_mcp_ + first 6 random chars, for display

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Mint a new token for a user+workspace. Returns { token, prefix, id }.
 * `token` is the raw secret — it is shown to the user ONCE and never stored.
 */
async function mintToken({ userId, tenantId, label = null, scopes = 'read,write' }) {
  if (!userId || !tenantId) throw new Error('mintToken requires userId and tenantId');
  const raw = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(raw);
  const tokenPrefix = raw.slice(0, PREFIX_STORE_LEN);
  const row = await db.prepare(
    `INSERT INTO mcp_tokens (token_hash, token_prefix, user_id, tenant_id, label, scopes)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
  ).get(tokenHash, tokenPrefix, userId, tenantId, label, scopes);
  return { token: raw, prefix: tokenPrefix, id: row?.id };
}

// Throttle last_used_at writes so a chatty client doesn't write on every call.
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;
const lastUsedTouchedAt = new Map(); // token id -> epoch ms of last write

/**
 * Verify a presented raw token. Returns { id, userId, tenantId, scopes } or null.
 * Constant-work: always hashes before the lookup so timing doesn't leak validity.
 */
async function verifyToken(raw) {
  if (typeof raw !== 'string' || !raw.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = hashToken(raw);
  const row = await db.prepare(
    `SELECT id, user_id, tenant_id, scopes
     FROM   mcp_tokens
     WHERE  token_hash = ? AND revoked_at IS NULL`
  ).get(tokenHash);
  if (!row) return null;

  // Fire-and-forget, throttled last_used_at bump.
  const now = Date.now();
  const last = lastUsedTouchedAt.get(row.id) || 0;
  if (now - last > LAST_USED_THROTTLE_MS) {
    lastUsedTouchedAt.set(row.id, now);
    db.prepare('UPDATE mcp_tokens SET last_used_at = now() WHERE id = ?')
      .run(row.id)
      .catch(() => {});
  }

  return {
    id: row.id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    scopes: (row.scopes || 'read').split(',').map(s => s.trim()).filter(Boolean),
  };
}

/** List a user's active + revoked tokens for a settings UI (never returns the secret). */
async function listTokens(userId, tenantId) {
  return db.prepare(
    `SELECT id, token_prefix, label, scopes, created_at, last_used_at, revoked_at
     FROM   mcp_tokens
     WHERE  user_id = ? AND tenant_id = ?
     ORDER  BY created_at DESC`
  ).all(userId, tenantId);
}

/** Revoke a token the caller owns. Returns true if a row was revoked. */
async function revokeToken(id, userId, tenantId) {
  const res = await db.prepare(
    `UPDATE mcp_tokens SET revoked_at = now()
     WHERE  id = ? AND user_id = ? AND tenant_id = ? AND revoked_at IS NULL`
  ).run(id, userId, tenantId);
  return (res.changes || 0) > 0;
}

module.exports = { mintToken, verifyToken, listTokens, revokeToken };

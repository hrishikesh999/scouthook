'use strict';

/**
 * LinkedIn connection health.
 *
 * The problem this module exists to solve: a LinkedIn token can die long before
 * `expires_at` says it will. When a member revokes ScoutHook (Settings → Data
 * privacy → Permitted services), changes their password, or trips a LinkedIn
 * security check, both the access and the refresh token are killed immediately —
 * but our stored `expires_at` still reads weeks or months into the future. Every
 * gate that inferred health from that date therefore reported a healthy
 * connection, and the user found out only when a publish came back 401.
 *
 * So health is recorded here as an observed fact — what LinkedIn last told us —
 * rather than inferred from a date. Two entry points feed it:
 *
 *   1. Reactive: any LinkedIn API call that comes back with an auth failure runs
 *      through `throwIfAuthFailure`, which normalises the response into a single
 *      `reconnect_required` error. The caller that owns the connection row then
 *      calls `markConnectionDead`, so one 401 anywhere flags the connection for
 *      everyone.
 *   2. Proactive: `probeConnection` asks LinkedIn directly. Called at login and
 *      from a daily sweep, so a revoked connection is surfaced before the user
 *      composes a post rather than after.
 *
 * `./linkedinOAuth` is required lazily inside functions throughout: it requires
 * this module for the reactive path, and a top-level require in both directions
 * would deadlock the module graph.
 */

const { db } = require('../db');
const { sendEmailToUser } = require('../emails');

const LINKEDIN_USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';

// LinkedIn reports a dead token in more than one dialect depending on which API
// surface answered — a `code` string on the newer REST endpoints, a numeric
// `serviceErrorCode` on the v2 ones. Both are matched, and a bare 401 with an
// unrecognised body still counts: the status alone is enough to know the token
// will not work, and treating it as anything else is how we ended up showing
// users raw JSON.
const AUTH_ERROR_CODES = new Set([
  'REVOKED_ACCESS_TOKEN',
  'EXPIRED_ACCESS_TOKEN',
  'INVALID_ACCESS_TOKEN',
]);
const AUTH_SERVICE_ERROR_CODES = new Set([65600, 65601, 65604]);

/**
 * Classify a LinkedIn error response as an auth failure or not.
 *
 * @param {number} status    HTTP status
 * @param {string} [bodyText]  Raw response body
 * @returns {string|null}  A short reason ('revoked' | 'expired' | 'invalid_token' |
 *                         'unauthorized'), or null if this is not an auth failure.
 */
function classifyAuthFailure(status, bodyText = '') {
  if (status !== 401) return null;

  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch { /* LinkedIn occasionally answers with plain text — status still decides */ }

  const code = String(parsed?.code || '').toUpperCase();
  if (code === 'REVOKED_ACCESS_TOKEN') return 'revoked';
  if (code === 'EXPIRED_ACCESS_TOKEN') return 'expired';
  if (AUTH_ERROR_CODES.has(code)) return 'invalid_token';

  const svc = Number(parsed?.serviceErrorCode);
  if (svc === 65601) return 'revoked';
  if (svc === 65600) return 'expired';
  if (AUTH_SERVICE_ERROR_CODES.has(svc)) return 'invalid_token';

  return 'unauthorized';
}

/**
 * Throw a normalised `reconnect_required` error if the response is an auth
 * failure. Call this from every LinkedIn `if (!res.ok)` branch, before building
 * the generic "LinkedIn API error N" message — that generic message is what used
 * to leak raw JSON into the UI and slip past the non-retriable error list.
 *
 * The thrown error carries `.linkedinAuthReason` so the caller holding the
 * connection row can record why without re-parsing the body.
 *
 * @param {number} status
 * @param {string} [bodyText]
 */
function throwIfAuthFailure(status, bodyText = '') {
  const reason = classifyAuthFailure(status, bodyText);
  if (!reason) return;
  throw Object.assign(new Error('reconnect_required'), { linkedinAuthReason: reason });
}

/** True for the error `throwIfAuthFailure` throws, and for equivalents raised elsewhere. */
function isReconnectRequired(err) {
  return err?.message === 'reconnect_required' || !!err?.linkedinAuthReason;
}

// ---------------------------------------------------------------------------
// Health state
// ---------------------------------------------------------------------------

/**
 * Flag a connection as needing reconnection and notify every workspace member
 * (in-app + email, deduped by the existing unread-notification rule).
 *
 * Idempotent: re-flagging an already-flagged connection leaves the original
 * `needs_reconnect_at` in place, so "how long has this been broken" stays
 * answerable and repeated failures don't re-notify.
 *
 * Never throws — a failure to record health must not turn into a second failure
 * on top of the publish that is already going wrong.
 *
 * @param {object} connection  Row from linkedin_connections
 * @param {string} [reason]    Classified reason, e.g. 'revoked'
 */
async function markConnectionDead(connection, reason = 'unauthorized') {
  if (!connection?.id) return;
  try {
    const wasHealthy = await db.prepare(`
      UPDATE linkedin_connections
      SET needs_reconnect_at = COALESCE(needs_reconnect_at, now()),
          last_error         = ?,
          updated_at         = now()
      WHERE id = ? AND needs_reconnect_at IS NULL
      RETURNING id
    `).get(reason, connection.id);

    if (!wasHealthy) return; // already flagged — members were notified then

    console.warn(`[linkedinHealth] connection=${connection.id} workspace=${connection.workspace_id} flagged: ${reason}`);
    await notifyWorkspaceReconnect(connection, reason);
  } catch (e) {
    console.warn('[linkedinHealth] markConnectionDead failed (non-fatal):', e.message);
  }
}

/**
 * Flag a workspace's default personal connection. For call sites that hold a
 * workspace id rather than a connection row — the metrics sync, for one, which
 * resolves its token by workspace.
 *
 * @param {string} workspaceId
 * @param {string} [reason]
 */
async function markWorkspaceConnectionDead(workspaceId, reason = 'unauthorized') {
  if (!workspaceId) return;
  try {
    const row = await db.prepare(`
      SELECT * FROM linkedin_connections
      WHERE workspace_id = ? AND account_type = 'personal' AND is_default = true
    `).get(workspaceId);
    if (row) await markConnectionDead(row, reason);
  } catch (e) {
    console.warn('[linkedinHealth] markWorkspaceConnectionDead failed (non-fatal):', e.message);
  }
}

/**
 * Record that LinkedIn just accepted this token, clearing any reconnect flag.
 * Called after a successful probe and after a successful re-authorisation.
 *
 * @param {number|object} connection  Row or id
 */
async function markConnectionAlive(connection) {
  const id = typeof connection === 'object' ? connection?.id : connection;
  if (!id) return;
  try {
    await db.prepare(`
      UPDATE linkedin_connections
      SET needs_reconnect_at = NULL,
          last_error         = NULL,
          last_verified_at   = now(),
          updated_at         = now()
      WHERE id = ?
    `).run(id);
  } catch (e) {
    console.warn('[linkedinHealth] markConnectionAlive failed (non-fatal):', e.message);
  }
}

/**
 * Clear the reconnect flag for every connection a workspace holds. Used after a
 * successful OAuth callback: the user just proved the connection works, and
 * leaving a stale flag would keep publishing blocked behind a Reconnect button
 * that they have already pressed.
 *
 * @param {string} workspaceId
 */
async function clearWorkspaceReconnectFlags(workspaceId) {
  if (!workspaceId) return;
  try {
    await db.prepare(`
      UPDATE linkedin_connections
      SET needs_reconnect_at = NULL,
          last_error         = NULL,
          last_verified_at   = now(),
          updated_at         = now()
      WHERE workspace_id = ? AND needs_reconnect_at IS NOT NULL
    `).run(workspaceId);
  } catch (e) {
    console.warn('[linkedinHealth] clearWorkspaceReconnectFlags failed (non-fatal):', e.message);
  }
}

/**
 * Notify every member of the workspace that a connection needs reconnecting.
 * Deduped per user on an existing unread notification, and the email is deduped
 * to once per 24 h by the mailer.
 *
 * @param {object} connection
 * @param {string} [reason]
 */
async function notifyWorkspaceReconnect(connection, reason = 'unauthorized') {
  try {
    const members = await db.prepare(
      'SELECT user_id FROM workspace_members WHERE workspace_id = ?'
    ).all(connection.workspace_id);

    const connName = connection.display_name || 'your LinkedIn account';
    const appUrl   = process.env.APP_URL || '';

    // A revoked token is a thing the member did on LinkedIn's side, so saying
    // "expired" there would send them looking for a problem that isn't the one
    // they have. Everything else is close enough to expiry to read as expiry.
    const body = reason === 'revoked'
      ? `Access to "${connName}" was revoked on LinkedIn, so ScoutHook can no longer publish for you. Reconnect to start publishing again.`
      : `The LinkedIn connection for "${connName}" is no longer valid. Please reconnect to continue publishing.`;

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
        `).run(m.user_id, connection.workspace_id, body);

        sendEmailToUser(m.user_id, 'linkedin-reconnect', { app_url: appUrl },
          { dedupKey: `reconnect_${connection.workspace_id}_${connection.id}`, withinHours: 24 })
          .catch(() => {});
      } catch { /* per-member errors are non-fatal */ }
    }
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Proactive probing
// ---------------------------------------------------------------------------

/**
 * Ask LinkedIn whether this connection's token still works, and record the answer.
 *
 * Uses the OpenID userinfo endpoint: it is the cheapest authenticated GET on the
 * API, needs no scope beyond the `openid profile` every connection already has
 * (so it works for identity-only connections too), and has no side effects.
 *
 * Only auth failures flag the connection. A network error, a 429, or a 5xx says
 * nothing about the token's validity — flagging on those would tell healthy users
 * to reconnect because LinkedIn was briefly unwell.
 *
 * @param {object} connection  Row from linkedin_connections
 * @returns {Promise<boolean>}  true if the token works, false if it is dead,
 *                              true if we could not tell (benefit of the doubt)
 */
async function probeConnection(connection) {
  if (!connection?.access_token_enc) return true;

  const { decrypt } = require('./linkedinOAuth');

  let accessToken;
  try {
    accessToken = decrypt(connection.access_token_enc);
  } catch (e) {
    console.warn(`[linkedinHealth] probe could not decrypt connection=${connection.id}:`, e.message);
    return true;
  }

  let res;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      res = await fetch(LINKEDIN_USERINFO_URL, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    console.warn(`[linkedinHealth] probe network error for connection=${connection.id} (inconclusive):`, e.message);
    return true;
  }

  if (res.ok) {
    await markConnectionAlive(connection);
    return true;
  }

  const bodyText = await res.text().catch(() => '');
  const reason = classifyAuthFailure(res.status, bodyText);
  if (!reason) {
    console.warn(`[linkedinHealth] probe got ${res.status} for connection=${connection.id} (inconclusive)`);
    return true;
  }

  await markConnectionDead(connection, reason);
  return false;
}

/**
 * Probe every personal connection in a workspace. Fire-and-forget from the login
 * path — the point is that a user who had their access revoked sees the reconnect
 * prompt when they arrive, not when they try to publish.
 *
 * @param {string} workspaceId
 */
async function probeWorkspaceConnections(workspaceId) {
  if (!workspaceId) return;
  try {
    const rows = await db.prepare(`
      SELECT * FROM linkedin_connections
      WHERE workspace_id = ? AND account_type = 'personal'
    `).all(workspaceId);

    // Org pages ride on the same underlying member token, so probing the personal
    // rows covers them; probing each separately would just repeat the same call.
    const seen = new Set();
    for (const row of rows) {
      const key = row.linkedin_member_id || `conn_${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await probeConnection(row);
    }
  } catch (e) {
    console.warn('[linkedinHealth] probeWorkspaceConnections failed (non-fatal):', e.message);
  }
}

/**
 * Daily sweep: probe every connection we currently believe is healthy.
 *
 * Catches the user who was revoked and has not logged in since — they get the
 * email while their scheduled posts are still in the future, instead of finding
 * out when the queue quietly fails to publish them.
 *
 * Already-flagged connections are skipped: they have been notified, and nothing
 * short of a re-authorisation will change their state.
 *
 * @returns {Promise<{ checked: number, dead: number }>}
 */
async function sweepConnectionHealth() {
  let checked = 0;
  let dead = 0;
  try {
    const rows = await db.prepare(`
      SELECT * FROM linkedin_connections
      WHERE account_type = 'personal' AND needs_reconnect_at IS NULL
      ORDER BY COALESCE(last_verified_at, created_at) ASC
    `).all();

    const seen = new Set();
    for (const row of rows) {
      const key = `${row.workspace_id}:${row.linkedin_member_id || row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      checked++;
      const alive = await probeConnection(row);
      if (!alive) dead++;

      // Spread the sweep out — LinkedIn throttles per app, and this loop has all
      // day to finish. Nothing is waiting on it.
      await new Promise(r => setTimeout(r, 250));
    }
    console.log(`[linkedinHealth] sweep complete — checked=${checked} dead=${dead}`);
  } catch (e) {
    console.warn('[linkedinHealth] sweepConnectionHealth failed (non-fatal):', e.message);
  }
  return { checked, dead };
}

module.exports = {
  classifyAuthFailure,
  throwIfAuthFailure,
  isReconnectRequired,
  markConnectionDead,
  markWorkspaceConnectionDead,
  markConnectionAlive,
  clearWorkspaceReconnectFlags,
  notifyWorkspaceReconnect,
  probeConnection,
  probeWorkspaceConnections,
  sweepConnectionHealth,
};

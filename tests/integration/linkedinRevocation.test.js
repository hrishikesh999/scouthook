'use strict';

/**
 * A revoked LinkedIn connection is a THIRD failure state.
 *
 * It is not "not connected" (the row, the name and the photo are all still real)
 * and it is not "missing the publish scope" (the member granted that, then took it
 * back on LinkedIn's side). It has its own recovery — re-authorise — and until
 * this fix nothing in the app could tell it apart from a healthy connection:
 * expires_at still read months out, so status said publish-capable, and the first
 * symptom was a raw LinkedIn 401 body rendered to the user mid-publish.
 *
 * These tests hold the line that a connection LinkedIn has stopped accepting is
 * refused everywhere the user might act on it, with an error the client recovers
 * from rather than a 500 carrying LinkedIn's JSON.
 */

require('dotenv').config();
const { getDb, createUser, loginAs, truncateAll } = require('./helpers/setup');
const {
  LINKEDIN_GRANT_PUBLISH,
  connectLinkedIn,
  withLinkedInOAuthEnv,
} = require('./helpers/signupFlow');
const {
  markConnectionDead,
  clearWorkspaceReconnectFlags,
} = require('../../services/linkedinHealth');

withLinkedInOAuthEnv();
afterEach(truncateAll);
jest.setTimeout(60000);

/** A Pro user holding a fully publish-capable connection. */
async function proUserWithConnection() {
  const user = await createUser();
  await getDb().prepare(`
    INSERT INTO user_subscriptions (user_id, plan, status)
    VALUES (?, 'pro', 'active')
    ON CONFLICT (user_id) DO UPDATE SET plan = 'pro', status = 'active'
  `).run(user.userId);
  const ag = await loginAs(user);
  await connectLinkedIn(user.workspaceId, user.userId, { scopes: LINKEDIN_GRANT_PUBLISH });
  return { user, ag };
}

/** The row for a workspace's default personal connection. */
function connectionFor(workspaceId) {
  return getDb().prepare(
    "SELECT * FROM linkedin_connections WHERE workspace_id = ? AND account_type = 'personal' AND is_default = true"
  ).get(workspaceId);
}

/**
 * Reproduce what a LinkedIn 401 does — the same call the publish path makes when
 * it classifies a response as an auth failure.
 */
async function revoke(workspaceId) {
  const conn = await connectionFor(workspaceId);
  await markConnectionDead(conn, 'revoked');
  return conn;
}

/** Far enough ahead to clear the 5-minute minimum lead time. */
function soon() {
  return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
}

describe('A connection LinkedIn has revoked', () => {
  test('status stops reporting it as publish-capable', async () => {
    const { user, ag } = await proUserWithConnection();

    const before = await ag.get('/api/linkedin/status');
    expect(before.body.can_publish).toBe(true);
    expect(before.body.needs_reconnect).toBeFalsy();

    await revoke(user.workspaceId);

    const after = await ag.get('/api/linkedin/status');
    // Still connected: the account is real and the UI needs its name to say WHICH
    // account to reconnect. What it cannot do is publish.
    expect(after.body.connected).toBe(true);
    expect(after.body.can_publish).toBe(false);
    expect(after.body.needs_reconnect).toBe(true);
  });

  test('publish is refused with reconnect_required, not a 500 full of LinkedIn JSON', async () => {
    const { user, ag } = await proUserWithConnection();
    await revoke(user.workspaceId);

    const res = await ag.post('/api/linkedin/publish').send({ content: 'Hello world.' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('reconnect_required');
    // The regression this replaces: a 500 whose body was LinkedIn's raw error,
    // which the editor printed verbatim in red with nowhere for the user to go.
    expect(JSON.stringify(res.body)).not.toMatch(/REVOKED_ACCESS_TOKEN|serviceErrorCode/);
  });

  test('SCHEDULING is refused too — a queued post against a dead token fails silently later', async () => {
    const { user, ag } = await proUserWithConnection();
    await revoke(user.workspaceId);

    const res = await ag.post('/api/linkedin/schedule')
      .send({ content: 'Hello world.', scheduled_for: soon() });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('reconnect_required');

    const queued = await getDb().prepare(
      'SELECT COUNT(*)::int AS cnt FROM scheduled_posts WHERE tenant_id = ?'
    ).get(user.workspaceId);
    expect(queued.cnt).toBe(0);
  });

  test('the connection picker stops offering it', async () => {
    const { user, ag } = await proUserWithConnection();
    await revoke(user.workspaceId);

    const res = await ag.get('/api/linkedin/connections');
    const conn = res.body.connections.find(c => c.account_type === 'personal');
    expect(conn.needs_reconnect).toBe(true);
    expect(conn.can_publish).toBe(false);
  });
});

describe('Telling the user', () => {
  test('every workspace member gets an in-app reconnect notification', async () => {
    const { user } = await proUserWithConnection();
    await revoke(user.workspaceId);

    const note = await getDb().prepare(`
      SELECT title, body FROM notifications
      WHERE user_id = ? AND tenant_id = ? AND type = 'reconnect_required'
    `).get(user.userId, user.workspaceId);

    expect(note).toBeTruthy();
    // Revocation is something the member did on LinkedIn, so the copy must not
    // send them looking for an expiry date that has not passed.
    expect(note.body).toMatch(/revoked/i);
    expect(note.body).not.toMatch(/expired/i);
  });

  test('re-flagging does not re-notify or reset when it broke', async () => {
    const { user } = await proUserWithConnection();
    await revoke(user.workspaceId);

    const first = await connectionFor(user.workspaceId);
    const flaggedAt = (await connectionFor(user.workspaceId)).needs_reconnect_at;

    await markConnectionDead(first, 'revoked');
    await markConnectionDead(first, 'revoked');

    const notes = await getDb().prepare(`
      SELECT COUNT(*)::int AS cnt FROM notifications
      WHERE tenant_id = ? AND type = 'reconnect_required'
    `).get(user.workspaceId);
    expect(notes.cnt).toBe(1);

    const still = await connectionFor(user.workspaceId);
    expect(new Date(still.needs_reconnect_at).getTime()).toBe(new Date(flaggedAt).getTime());
  });
});

describe('Recovering', () => {
  test('clearing the flag restores publishing', async () => {
    const { user, ag } = await proUserWithConnection();
    await revoke(user.workspaceId);

    // What the OAuth callback does once the user has re-authorised.
    await clearWorkspaceReconnectFlags(user.workspaceId);

    const res = await ag.get('/api/linkedin/status');
    expect(res.body.needs_reconnect).toBe(false);
    expect(res.body.can_publish).toBe(true);

    const row = await connectionFor(user.workspaceId);
    expect(row.needs_reconnect_at).toBeNull();
    expect(row.last_error).toBeNull();
    expect(row.last_verified_at).toBeTruthy();
  });
});

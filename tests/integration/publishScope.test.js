'use strict';

/**
 * Publish capability is a THIRD state, not a second one.
 *
 * Since /start signs users in with `openid profile` alone, "connected" stopped
 * implying "can publish". Publishing already enforced that; scheduling did not —
 * it checked only that a connection existed, so a new signup could schedule a
 * post, get a confirmation, and have the background job fail the scope check
 * hours later, retry three times, and mark itself failed without telling anyone.
 *
 * These tests hold the line that a read-only connection is refused at the point
 * the user is still watching, with an error the editor knows how to act on.
 */

require('dotenv').config();
const { getDb, createUser, loginAs, truncateAll } = require('./helpers/setup');
const { seedTrialSubscription } = require('../../services/subscription');
const {
  LINKEDIN_GRANT_IDENTITY,
  LINKEDIN_GRANT_PUBLISH,
  connectLinkedIn,
  withLinkedInOAuthEnv,
} = require('./helpers/signupFlow');

withLinkedInOAuthEnv();
afterEach(truncateAll);
jest.setTimeout(60000);

/**
 * A logged-in user on a trial, whose workspace holds a connection with the given
 * grant.
 *
 * The trial matters: publish checks the PLAN before the scope, and scheduling is
 * a Pro feature, so a user with no subscription row is refused with plan_expired
 * or feature_not_available long before either endpoint looks at scopes — and the
 * scope behaviour under test would never run.
 */
async function userWithConnection(scopes) {
  const user = await createUser();
  await seedTrialSubscription(user.userId);
  const ag = await loginAs(user);
  if (scopes) await connectLinkedIn(user.workspaceId, user.userId, { scopes });
  return { user, ag };
}

/** Far enough ahead to clear the 5-minute minimum lead time. */
function soon() {
  return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
}

describe('Read-only LinkedIn connection', () => {
  test('status reports connected but not publish-capable', async () => {
    const { ag } = await userWithConnection(LINKEDIN_GRANT_IDENTITY);
    const res = await ag.get('/api/linkedin/status');
    expect(res.body.connected).toBe(true);
    expect(res.body.can_publish).toBe(false);
  });

  test('publish is refused with the error the client recovers from', async () => {
    const { ag } = await userWithConnection(LINKEDIN_GRANT_IDENTITY);
    const res = await ag.post('/api/linkedin/publish').send({ content: 'Hello world.' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('publish_scope_required');
  });

  test('SCHEDULING is refused too — the regression that lost posts silently', async () => {
    const { ag } = await userWithConnection(LINKEDIN_GRANT_IDENTITY);
    const res = await ag.post('/api/linkedin/schedule').send({
      content: 'Hello world.',
      scheduled_for: soon(),
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('publish_scope_required');
  });

  test('nothing is queued when scheduling is refused', async () => {
    const { user, ag } = await userWithConnection(LINKEDIN_GRANT_IDENTITY);
    await ag.post('/api/linkedin/schedule').send({ content: 'Hello world.', scheduled_for: soon() });

    const db = getDb();
    const { cnt } = await db.prepare(
      'SELECT COUNT(*)::int AS cnt FROM scheduled_posts WHERE tenant_id = ?'
    ).get(user.workspaceId);
    // A row here means the refusal was cosmetic and the job will still run.
    expect(cnt).toBe(0);
  });

  test('the account list marks the connection unpublishable', async () => {
    const { ag } = await userWithConnection(LINKEDIN_GRANT_IDENTITY);
    const res = await ag.get('/api/linkedin/connections');
    expect(res.body.ok).toBe(true);
    expect(res.body.connections.length).toBe(1);
    expect(res.body.connections[0].can_publish).toBe(false);
    // The computed boolean is the contract; the raw grant string stays server-side.
    expect(res.body.connections[0].scopes).toBeUndefined();
  });
});

describe('Publish-capable LinkedIn connection', () => {
  // LinkedIn returns its grant comma-separated. A parser that split on
  // whitespace alone read this as read-only and blocked publishing entirely.
  test('status reports publish-capable despite comma separators', async () => {
    const { ag } = await userWithConnection(LINKEDIN_GRANT_PUBLISH);
    const res = await ag.get('/api/linkedin/status');
    expect(res.body.connected).toBe(true);
    expect(res.body.can_publish).toBe(true);
  });

  test('the account list marks it publishable', async () => {
    const { ag } = await userWithConnection(LINKEDIN_GRANT_PUBLISH);
    const res = await ag.get('/api/linkedin/connections');
    expect(res.body.connections[0].can_publish).toBe(true);
  });

  test('scheduling clears the scope gate', async () => {
    const { ag } = await userWithConnection(LINKEDIN_GRANT_PUBLISH);
    const res = await ag.post('/api/linkedin/schedule').send({
      content: 'Hello world.',
      scheduled_for: soon(),
    });
    // Whatever happens next (the scheduler may be disabled in this environment),
    // it must not be the scope refusal — that is what this asserts.
    expect(res.body.error).not.toBe('publish_scope_required');
  });
});

describe('Granting the write scope from the editor', () => {
  test('asks LinkedIn for w_member_social and returns to the post', async () => {
    const { ag } = await userWithConnection(LINKEDIN_GRANT_IDENTITY);
    const res = await ag.get('/api/linkedin/connect?from=editor_publish&post_id=4242');
    expect(res.status).toBe(302);

    const url = new URL(res.headers.location);
    expect(url.searchParams.get('scope')).toBe('openid profile w_member_social');
  });

  test('a post_id that is not a post id degrades to Drafts rather than redirecting anywhere', async () => {
    const { ag } = await userWithConnection(LINKEDIN_GRANT_IDENTITY);
    // The return path is built from a digits-only id, never echoed from the query,
    // so there is nothing here for an open redirect to latch onto.
    const res = await ag.get('/api/linkedin/connect?from=editor_publish&post_id=https://evil.example.com');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/www\.linkedin\.com\//);
  });
});

describe('No LinkedIn connection at all', () => {
  test('scheduling never blames a missing scope when there is no connection', async () => {
    const { ag } = await userWithConnection(null);
    const res = await ag.post('/api/linkedin/schedule').send({
      content: 'Hello world.',
      scheduled_for: soon(),
    });
    // not_connected in production. This environment has no Redis, so the
    // scheduler-availability check returns 503 first — either way, the one
    // answer that would be WRONG is the scope error, because there is no
    // connection whose scopes could be at fault.
    expect(res.body.ok).toBe(false);
    expect(res.body.error).not.toBe('publish_scope_required');
  });

  test('status reports neither connected nor publish-capable', async () => {
    const { ag } = await userWithConnection(null);
    const res = await ag.get('/api/linkedin/status');
    expect(res.body.connected).toBe(false);
    expect(res.body.can_publish).toBeFalsy();
  });
});

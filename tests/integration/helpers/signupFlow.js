'use strict';

/**
 * Helpers for the signup-flow test.
 *
 * The one step that cannot be driven from here is the LinkedIn OAuth hop: it is
 * a third party with a consent screen. Everything up to the redirect IS driven
 * (we assert the scope we send), and the callback's EFFECT is reproduced by
 * writing the connection row the callback would write — including LinkedIn's own
 * comma-separated scope format, so the flow test exercises the same string
 * production gets rather than a tidied-up one.
 */

const { getDb } = require('./setup');

/** Exactly what LinkedIn's token endpoint returns for the two /start asks. */
const LINKEDIN_GRANT_IDENTITY = 'openid,profile';
const LINKEDIN_GRANT_PUBLISH  = 'openid,profile,w_member_social';

/**
 * Write the connection row the OAuth callback would write.
 *
 * access_token_enc is a placeholder: nothing in the flow test decrypts it. The
 * publish scope gate runs before token decryption, which is the only publish
 * behaviour a test may exercise — actually publishing would post to a real
 * LinkedIn feed.
 */
async function connectLinkedIn(workspaceId, userId, { scopes, memberId = 'li_test_member' } = {}) {
  const db = getDb();
  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
  // In a transaction for the same reason createUser's inserts are: Neon's
  // serverless pooler runs in transaction mode, so consecutive autocommit
  // statements can land on different compute instances and a row written through
  // one is not reliably visible to the next read. Outside a transaction this
  // insert intermittently "succeeded" and then the app resolved no connection —
  // a 401 in a test that passed when run on its own.
  await db.transaction(async tx => {
    await tx.prepare(`
      INSERT INTO linkedin_connections
        (workspace_id, authorized_by, account_type, account_key,
         display_name, avatar_url, linkedin_member_id,
         access_token_enc, refresh_token_enc, expires_at, is_default, scopes)
      VALUES (?, ?, 'personal', ?, ?, NULL, ?, 'test-token-not-decrypted', NULL, ?, true, ?)
      ON CONFLICT (workspace_id, account_key) DO UPDATE SET scopes = EXCLUDED.scopes
    `).run(
      workspaceId, userId, 'person_' + memberId,
      'Test Member', memberId, expiresAt, scopes
    );
  });
}

/**
 * Read a row that an HTTP request just wrote, tolerating the same replication
 * lag. Returns null if it never appears, so the caller's own assertion reports
 * the failure rather than a timeout.
 */
async function eventually(query, { tries = 10, delayMs = 150 } = {}) {
  for (let i = 0; i < tries; i++) {
    const row = await query();
    if (row) return row;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

/** The user + workspace ids for an account created through the real signup flow. */
async function accountFor(email) {
  const db = getDb();
  const user = await eventually(() =>
    db.prepare('SELECT user_id FROM user_profiles WHERE email = ?').get(String(email).toLowerCase()));
  if (!user) return { userId: null, workspaceId: null };
  const ws = await eventually(() =>
    db.prepare('SELECT workspace_id FROM workspace_members WHERE user_id = ?').get(user.user_id));
  return { userId: user.user_id, workspaceId: ws?.workspace_id || null };
}

/** Upgrade an existing connection to the write scope, as the second OAuth hop does. */
async function grantPublishScope(workspaceId, memberId = 'li_test_member') {
  const db = getDb();
  await db.prepare(
    'UPDATE linkedin_connections SET scopes = ? WHERE workspace_id = ? AND account_key = ?'
  ).run(LINKEDIN_GRANT_PUBLISH, workspaceId, 'person_' + memberId);
}

/** The verification PIN, which the real user reads out of an email we don't send in tests. */
async function verificationPin(email) {
  const db = getDb();
  const row = await db.prepare(
    "SELECT verify_token FROM auth_providers WHERE provider = 'email' AND provider_id = ?"
  ).get(String(email).toLowerCase());
  return row?.verify_token || null;
}

/**
 * The exact body public/js/start.js posts to /api/generate.
 *
 * Kept here rather than inlined so the flow test and the static contract test
 * describe the same request, and so a future field lands in one place.
 */
function startGenerateBody(rawIdea, { briefMode = false } = {}) {
  return {
    path: 'idea',
    raw_idea: rawIdea,
    post_type: 'auto',
    source: 'start_flow',
    enforce_retention: true,
    generation_mode: 'organize',
    brief_mode: briefMode,
  };
}

/**
 * Give the OAuth entry point the two env vars it refuses to run without.
 *
 * Real LinkedIn credentials are not in any test environment and must not be: the
 * assertions here are about the URL we BUILD, and nothing in these tests talks to
 * LinkedIn. The connect handler reads both per request, so setting them at test
 * time is enough and no app reload is needed.
 *
 * Call at the top of a describe/file; it registers its own beforeAll/afterAll and
 * restores whatever was there before.
 */
function withLinkedInOAuthEnv() {
  const saved = {};
  const values = {
    LINKEDIN_CLIENT_ID:    'test-client-id',
    LINKEDIN_REDIRECT_URI: 'https://app.example.com/api/linkedin/callback',
  };
  beforeAll(() => {
    for (const [k, v] of Object.entries(values)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

module.exports = {
  LINKEDIN_GRANT_IDENTITY,
  LINKEDIN_GRANT_PUBLISH,
  connectLinkedIn,
  grantPublishScope,
  verificationPin,
  startGenerateBody,
  withLinkedInOAuthEnv,
  eventually,
  accountFor,
};

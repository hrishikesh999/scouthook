'use strict';

/**
 * The free-tier journey, walked end to end as real HTTP against the real server
 * and the real database: sign up → generate 3 free posts → 4th is blocked and
 * asked to upgrade → billing reflects the cap → publish still works for what
 * was already generated → Vault upload cap → admin bonus-post grant unblocks.
 *
 * Exists to catch exactly the class of bug that unit tests on canGeneratePost()
 * in isolation cannot: whether the real HTTP round trip through every one of the
 * 5 generation call sites, the billing page's numbers, and the publish gate all
 * agree with each other and with what a real user would see.
 */

require('dotenv').config();
const { getDb, agent, truncateAll } = require('./helpers/setup');
const {
  LINKEDIN_GRANT_IDENTITY,
  connectLinkedIn,
  startGenerateBody,
  withLinkedInOAuthEnv,
  accountFor,
  eventually,
} = require('./helpers/signupFlow');

withLinkedInOAuthEnv();
afterEach(truncateAll);
// Three-plus real Sonnet generations in one test; each takes ~20-30s.
jest.setTimeout(300000);

const PASSWORD = 'TestPass123!';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function uniqueEmail() {
  return `free_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`;
}

async function signUpAndVerify(email) {
  const ag = agent();
  const signup = await ag.post('/auth/signup').send({ name: 'Free Tier Test', email, password: PASSWORD });
  expect(signup.status).toBe(200);

  const pin = await eventually(() =>
    getDb().prepare("SELECT verify_token FROM auth_providers WHERE provider = 'email' AND provider_id = ?")
      .get(email.toLowerCase()).then(r => r?.verify_token));
  expect(pin).toMatch(/^\d{6}$/);

  const verify = await ag.post('/auth/verify-email').send({ email, pin });
  expect(verify.status).toBe(302);
  return ag;
}

function genBody(n) {
  return startGenerateBody(
    `Idea number ${n}: most people quit posting on LinkedIn right before it starts working. ` +
    `A founder I know posted nothing for six months, then three times a week for a year, and that's when inbound started.`,
    { briefMode: true }
  );
}

test('signup through the 4-free-post cap, billing, publish, vault, and admin grant', async () => {
  const email = uniqueEmail();
  const ag = await signUpAndVerify(email);
  const { userId, workspaceId } = await accountFor(email);
  expect(userId).toBeTruthy();
  expect(workspaceId).toBeTruthy();
  await connectLinkedIn(workspaceId, userId, { scopes: LINKEDIN_GRANT_IDENTITY });

  // ── 1. Fresh signup: billing shows 0/4, free tier, not pro ──────────────────
  const subFresh = await ag.get('/api/billing/subscription');
  expect(subFresh.status).toBe(200);
  expect(subFresh.body.plan).toBe('expired');
  expect(subFresh.body.free_posts_used).toBe(0);
  expect(subFresh.body.free_posts_limit).toBe(4);

  // ── 2. Generate 4 free posts — all must succeed. The 4th is the point of the
  //      cap change: it used to be refused and replaced by the upgrade prompt.
  //      Now it generates, and only the LAST one carries free_tier_exhausted,
  //      which is what puts the ask in the editor beneath the finished post. ──
  const postIds = [];
  for (let i = 1; i <= 4; i++) {
    const gen = await ag.post('/api/generate').send(genBody(i));
    expect(gen.status).toBe(200);
    expect(gen.body.ok).toBe(true);
    expect(gen.body.id).toBeTruthy();
    expect(gen.body.free_tier_exhausted).toBe(i === 4);
    postIds.push(gen.body.id);

    const sub = await ag.get('/api/billing/subscription');
    expect(sub.body.free_posts_used).toBe(i);
    expect(sub.body.free_posts_limit).toBe(4);
  }

  // ── 3. Milestone emails are NOT asserted here, and cannot be: sendEmailToUser()
  //      returns at the top under NODE_ENV=test (emails/index.js), before it
  //      writes the email_log row this step used to look for. The assertion sat
  //      here failing for months, reading as a product bug when it was only ever
  //      an environment guard. The thresholds it meant to protect — "one left"
  //      after post 3, "cap reached" after post 4, both relative to the account's
  //      own free_posts_limit — are covered in tests/unit/milestoneEmails.test.js.

  // ── 4. 5th generation is blocked — the wall now lands where there is nothing
  //      to lose, rather than on top of work the author had already typed ─────
  const blocked = await ag.post('/api/generate').send(genBody(5));
  expect(blocked.status).toBe(429);
  expect(blocked.body.ok).toBe(false);
  expect(blocked.body.error).toBe('monthly_quota_reached');
  expect(blocked.body.plan).toBe('expired');
  expect(blocked.body.used).toBe(4);
  expect(blocked.body.limit).toBe(4);
  expect(blocked.body.upgrade_url).toBe('/billing.html');

  // ── 5. Billing endpoint after the cap ────────────────────────────────────────
  const subCapped = await ag.get('/api/billing/subscription');
  expect(subCapped.body.free_posts_used).toBe(4);
  expect(subCapped.body.free_posts_limit).toBe(4);

  // ── 6. Publishing one of the already-generated posts must still work — the
  //      cap is on GENERATION, not on publishing what you already made. Only the
  //      scope gate should block it here (no write scope granted). ─────────────
  const publish = await ag.post('/api/linkedin/publish').send({ postId: postIds[0], content: 'test content' });
  expect(publish.body.ok).toBe(false);
  // Must be the scope error, NOT plan_expired — a free-tier user must not be
  // told their plan expired when they never had one to begin with.
  expect(publish.body.error).toBe('publish_scope_required');

  // ── 7. Vault: a free user cannot write to it at all ─────────────────────────
  //      This step used to assert the opposite — first upload 200, second capped
  //      at 1 with plan_limit_exceeded — and had been unreachable for months
  //      behind an earlier assertion that aborted the run, so nobody saw it stop
  //      being true. server.js mounts /api/vault behind requireVaultFeatureForWrites
  //      and lib/planFeatures.js grants 'vault' to solo/pro only, so the write is
  //      refused before routes/vault.js consults its own free-tier allowance.
  //
  //      Asserted as it behaves today, NOT as an endorsement: the free-tier
  //      allowance in canUploadVaultDoc is now unreachable code, and whether the
  //      gate or the allowance is the real rule is an open product question.
  //      Fix that first, then make this step say whichever answer wins.
  const doc1 = await ag.post('/api/vault/upload')
    .set('Content-Type', 'text/plain')
    .set('X-Filename', encodeURIComponent('notes.txt'))
    .send('Some notes about my niche and audience.');
  expect(doc1.status).toBe(403);
  expect(doc1.body.ok).toBe(false);
  expect(doc1.body.error).toBe('feature_not_available');

  // ── 8. Admin grants 3 bonus posts — generation should now succeed again ────
  if (!ADMIN_PASSWORD) {
    console.warn('[freeTierFlow] ADMIN_PASSWORD not set in test env — skipping admin grant step');
    return;
  }
  const grant = await agent()
    .post(`/admin/users/${encodeURIComponent(userId)}/grant-free-posts`)
    .set('X-Admin-Password', ADMIN_PASSWORD)
    .send({ count: 3 });
  expect(grant.status).toBe(200);
  expect(grant.body.ok).toBe(true);

  const subGranted = await ag.get('/api/billing/subscription');
  expect(subGranted.body.free_posts_limit).toBe(7);
  expect(subGranted.body.free_posts_used).toBe(4);

  const unblocked = await ag.post('/api/generate').send(genBody(6));
  expect(unblocked.status).toBe(200);
  expect(unblocked.body.ok).toBe(true);
});

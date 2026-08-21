'use strict';

/**
 * The signup journey, walked end to end as real HTTP against the real server and
 * the real database: sign up → verify → /start → connect → generate → edit →
 * publish gate → grant write scope.
 *
 * WHY THIS EXISTS. Three separate production breakages in this flow came from the
 * same blind spot: public/js/start.js is browser code with no harness, so nothing
 * ever exercised the requests and links it builds. Each one was invisible to the
 * unit suite and to a stubbed local preview, and each one broke the first thing a
 * new user does.
 *
 *   1. It posted to /api/generate without `path` → 400 on every first post.
 *   2. It left the engine to the maturity router → short answers were ghostwritten
 *      by postEngine, which does not measure fidelity, while the UI claimed
 *      "your words".
 *   3. It linked Edit at /editor.html?postId=N → the editor reads its id from the
 *      URL path, so the id resolved to the string "editor.html".
 *
 * Every step below asserts an OUTCOME the user would notice, not an implementation
 * detail — a post came back, the editor can load it, the publish gate says the
 * specific thing the client knows how to recover from.
 *
 * WHAT THIS CANNOT COVER, so it is not mistaken for total coverage:
 *   - The LinkedIn OAuth hop. Third party, consent screen. The redirect we send is
 *     asserted; the callback's effect is reproduced by helpers/signupFlow.js.
 *   - Actually publishing to LinkedIn. That would post to a real feed. The scope
 *     gate in front of it is asserted instead.
 *   - The DOM. Nothing here proves a button is wired to the handler it should be,
 *     only that the requests and routes behind it work. tests/unit/startFlowContract.js
 *     asserts the request bodies and links statically; between them the gap is a
 *     button whose listener is missing entirely, which needs a real browser.
 */

require('dotenv').config();
const { getDb, agent, truncateAll } = require('./helpers/setup');
// The floor itself, not a number retyped here — a test that hardcodes it stops
// tracking the behaviour the moment the floor moves.
const { ORGANIZE_MIN_RETENTION } = require('../../services/retention');
const {
  LINKEDIN_GRANT_IDENTITY,
  connectLinkedIn,
  grantPublishScope,
  verificationPin,
  startGenerateBody,
  withLinkedInOAuthEnv,
  accountFor,
  eventually,
} = require('./helpers/signupFlow');

withLinkedInOAuthEnv();
afterEach(truncateAll);
// One real generation runs in here; Sonnet takes ~20s and the flow has several
// round trips in front of it.
jest.setTimeout(180000);

const PASSWORD = 'TestPass123!';

/** Sign up and verify, returning a logged-in agent — steps 1 and 2 of the journey. */
async function signUpAndVerify(email) {
  const ag = agent();

  const signup = await ag.post('/auth/signup').send({ name: 'Flow Test', email, password: PASSWORD });
  expect(signup.status).toBe(200);
  expect(signup.body.ok).toBe(true);

  const pin = await verificationPin(email);
  expect(pin).toMatch(/^\d{6}$/);

  const verify = await ag.post('/auth/verify-email').send({ email, pin });
  return { ag, verify, pin };
}

function uniqueEmail() {
  return `flow_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`;
}

describe('Signup → first post → edit → publish', () => {
  test('a new signup lands on the generator, not the brand interview', async () => {
    const { verify } = await signUpAndVerify(uniqueEmail());
    expect(verify.status).toBe(302);
    // The whole activation bet: time-to-first-output over profile completeness.
    // Signup is three steps and no more — account, emailed code, write — so the
    // third step is the REGULAR generator. If this ever points at
    // /onboarding.html again, the inversion was undone.
    expect(verify.headers.location).toBe('/generate.html?new=1&first=1');
  });

  test('verifying seeds the free tier — without it, canGeneratePost has no row to count against', async () => {
    const email = uniqueEmail();
    await signUpAndVerify(email);

    const { userId } = await accountFor(email);
    expect(userId).toBeTruthy();
    const db = getDb();
    // seedFreeSubscription is fire-and-forget in the verify handler, so the row
    // can land just after the redirect returns.
    const sub = await eventually(() =>
      db.prepare('SELECT plan, status, free_posts_limit FROM user_subscriptions WHERE user_id = ?').get(userId));

    // New signups get 3 lifetime free generations (services/subscription.js
    // canGeneratePost), not a time-boxed trial. plan stays 'expired' — the DB
    // check constraint only allows 'expired'|'solo'|'pro' as a plan value —
    // while status='free' distinguishes never-subscribed users from lapsed ones.
    expect(sub).toBeTruthy();
    expect(sub.plan).toBe('expired');
    expect(sub.status).toBe('free');
    expect(sub.free_posts_limit).toBe(3);
  });

  test('/start.html requires a session', async () => {
    const anon = agent();
    const res  = await anon.get('/start.html');
    expect([302, 401, 403]).toContain(res.status);
  });

  test('sign-in asks LinkedIn for identity only; publish asks for the write scope', async () => {
    const { ag } = await signUpAndVerify(uniqueEmail());

    const signIn = await ag.get('/api/linkedin/connect?from=start');
    expect(signIn.status).toBe(302);
    const signInScope = new URL(signIn.headers.location).searchParams.get('scope');
    // "openid profile" renders on LinkedIn as a sign-in. Adding w_member_social
    // here would render it as "create, modify and delete posts on your behalf" at
    // the moment we are asking a stranger to trust us.
    expect(signInScope).toBe('openid profile');

    const publish = await ag.get('/api/linkedin/connect?from=start_publish');
    expect(publish.status).toBe(302);
    const publishScope = new URL(publish.headers.location).searchParams.get('scope');
    expect(publishScope).toBe('openid profile w_member_social');
  });

  test('an identity-only connection reads as connected but not publish-capable', async () => {
    const email = uniqueEmail();
    const { ag } = await signUpAndVerify(email);
    const { userId, workspaceId } = await accountFor(email);
    expect(workspaceId).toBeTruthy();

    // LinkedIn's own comma-separated grant string, not a tidied-up one. A parser
    // that splits on whitespace alone reports this as read-only, which is exactly
    // the bug that made "connected twice, still can't publish" possible.
    await connectLinkedIn(workspaceId, userId, { scopes: LINKEDIN_GRANT_IDENTITY });

    const status = await ag.get('/api/linkedin/status');
    expect(status.status).toBe(200);
    expect(status.body.connected).toBe(true);
    expect(status.body.can_publish).toBe(false);
  });

  test('granting the write scope flips can_publish, comma separators and all', async () => {
    const email = uniqueEmail();
    const { ag } = await signUpAndVerify(email);
    const { userId, workspaceId } = await accountFor(email);
    expect(workspaceId).toBeTruthy();

    await connectLinkedIn(workspaceId, userId, { scopes: LINKEDIN_GRANT_IDENTITY });
    await grantPublishScope(workspaceId);

    const status = await ag.get('/api/linkedin/status');
    expect(status.body.connected).toBe(true);
    expect(status.body.can_publish).toBe(true);
  });

  test('the full first post: generate → load in the editor → hit the publish gate', async () => {
    const email = uniqueEmail();
    const { ag } = await signUpAndVerify(email);
    const { userId, workspaceId } = await accountFor(email);
    expect(workspaceId).toBeTruthy();
    await connectLinkedIn(workspaceId, userId, { scopes: LINKEDIN_GRANT_IDENTITY });

    // ── Generate, with the exact body the browser sends ──────────────────────
    const answer   = 'Everybody obsesses over post quality on LinkedIn. The truth is consistency wins.';
    const followUp = 'A client of mine posted once a month for a year. Nothing. Then three a week and he got clients.';
    const gen = await ag.post('/api/generate').send(
      startGenerateBody(`${answer}\n\n${followUp}`, { briefMode: true })
    );

    expect(gen.status).toBe(200);
    expect(gen.body.ok).toBe(true);
    expect(typeof gen.body.post).toBe('string');
    expect(gen.body.post.trim().length).toBeGreaterThan(0);
    expect(gen.body.id).toBeTruthy();

    // The editor, never the writer. postEngine returns retention null, so a post
    // from that path cannot be shown as "your words" honestly — and the UI says
    // exactly that.
    expect(gen.body.generation_mode).toBe('organize');
    expect(gen.body.retention).toBeTruthy();
    expect(typeof gen.body.retention.score).toBe('number');

    // Every field public/js/start.js reads off this response must exist, or the
    // post screen paints a verdict badge from undefined.
    for (const field of ['id', 'post', 'quality', 'retention', 'retention_ok', 'hook_was_written']) {
      expect(gen.body).toHaveProperty(field);
    }

    // ── Edit: the route the Edit button links to must serve the editor ───────
    const postId = gen.body.id;
    const editorPage = await ag.get(`/editor/${postId}`);
    expect(editorPage.status).toBe(200);
    expect(editorPage.headers['content-type']).toMatch(/html/);

    // ...and the fetch that page makes on load must return the post. This pair is
    // what "Failed to load post" was: the page loaded, the id in the URL was the
    // string "editor.html", and this fetch 404'd.
    const loaded = await ag.get(`/api/generate/post/${postId}`);
    expect(loaded.status).toBe(200);
    expect(loaded.body.ok).toBe(true);
    expect(loaded.body.post.content).toBe(gen.body.post);

    // ── Publish, without the write scope ─────────────────────────────────────
    // Must be the specific error the client recovers from by reopening the
    // permission dialog. A generic 500 here strands a finished post.
    const publish = await ag.post('/api/linkedin/publish').send({ postId, content: gen.body.post });
    expect(publish.body.ok).toBe(false);
    expect(publish.body.error).toBe('publish_scope_required');
  });

  test('a post too thin to build on is FLAGGED, never quietly padded out', async () => {
    const email = uniqueEmail();
    const { ag } = await signUpAndVerify(email);

    // Under RAW_MIN_WORDS the browser asks a follow-up instead of generating, but
    // "Just use what I've got" reaches the server anyway. Six words cannot make a
    // post, and no amount of retrying changes that — only asking for more can.
    const gen = await ag.post('/api/generate').send(
      startGenerateBody('Consistency beats quality on LinkedIn.')
    );

    expect(gen.status).toBe(200);
    expect(gen.body.generation_mode).toBe('organize');

    // The contract is not "always faithful" — with this little material the editor
    // genuinely has to write a hook and a closing line, and it measured 0.44 here.
    // The contract is that we NOTICE: either the post clears the fidelity floor, or
    // retention_ok is false, which is what makes /start ask a follow-up instead of
    // presenting invented words as the author's. Silence would be the bug.
    const clearsFloor = gen.body.retention.score >= ORGANIZE_MIN_RETENTION;
    expect(clearsFloor || gen.body.retention_ok === false).toBe(true);
  });
});

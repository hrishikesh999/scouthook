'use strict';

const { getDb, agent, createUser, loginAs, truncateAll } = require('./helpers/setup');

afterEach(truncateAll);

// ---------------------------------------------------------------------------
// The sh_attr cookie — set by services/attribution.js middleware
// ---------------------------------------------------------------------------
describe('Attribution — utm capture middleware', () => {
  function shAttr(res) {
    const raw = res.headers['set-cookie'] || [];
    return raw.find(c => c.startsWith('sh_attr=')) || null;
  }

  function decode(cookieStr) {
    const value = cookieStr.split(';')[0].split('=').slice(1).join('=');
    return JSON.parse(Buffer.from(decodeURIComponent(value), 'base64').toString('utf8'));
  }

  test('sets sh_attr on a utm-tagged landing page request', async () => {
    const res = await agent().get(
      '/sign-up-a.html?utm_source=facebook&utm_medium=paid' +
      '&utm_campaign=prospecting_aug26&utm_content=ad1_invisible_expert'
    );

    const cookie = shAttr(res);
    expect(cookie).toBeTruthy();

    const attr = decode(cookie);
    expect(attr.utm_source).toBe('facebook');
    expect(attr.utm_medium).toBe('paid');
    expect(attr.utm_campaign).toBe('prospecting_aug26');
    expect(attr.utm_content).toBe('ad1_invisible_expert');
    expect(attr.landing_page).toBe('/sign-up-a.html');
  });

  test('captures fbclid even with no utm tags', async () => {
    const res  = await agent().get('/sign-up-a.html?fbclid=IwAR_test_click_123');
    const attr = decode(shAttr(res));
    expect(attr.click_id).toBe('IwAR_test_click_123');
  });

  test('does not set sh_attr on an untagged request', async () => {
    const res = await agent().get('/sign-up-a.html');
    expect(shAttr(res)).toBeNull();
  });

  test('is httpOnly so page scripts cannot tamper with attribution', async () => {
    const res = await agent().get('/sign-up-a.html?utm_source=facebook');
    expect(shAttr(res)).toMatch(/HttpOnly/i);
  });
});

// ---------------------------------------------------------------------------
// Attribution survives the signup → verify → user-row journey
// ---------------------------------------------------------------------------
describe('Attribution — persisted onto the created user', () => {
  test('a paid signup is stamped with the ad that produced it', async () => {
    const db    = getDb();
    const ag    = agent();
    const email = `paid_${Date.now()}@example.com`;

    // 1. Land on the ad's URL — this is what sets the cookie.
    await ag.get(
      '/sign-up-a.html?utm_source=facebook&utm_medium=paid' +
      '&utm_campaign=prospecting_aug26&utm_content=ad3_depth'
    );

    // 2. Submit the signup form.
    const signup = await ag.post('/auth/signup').send({ email, password: 'TestPass123!' });
    expect(signup.status).toBe(200);
    expect(signup.body.ok).toBe(true);

    // No user exists in a meaningful sense until the emailed code is entered,
    // so attribution must still be unwritten at this point.
    const pending = await db.prepare(
      'SELECT utm_campaign FROM user_profiles WHERE email = ?'
    ).get(email);
    expect(pending.utm_campaign).toBeNull();

    // 3. Enter the 6-digit code from the verification email.
    const row = await db.prepare(`
      SELECT ap.verify_token FROM auth_providers ap
      JOIN user_profiles up ON up.user_id = ap.user_id
      WHERE up.email = ? AND ap.provider = 'email'
    `).get(email);
    expect(row.verify_token).toMatch(/^\d{6}$/);

    await ag.post('/auth/verify-email').send({ email, pin: row.verify_token });

    // 4. The user row now carries the campaign that produced it.
    const user = await db.prepare(`
      SELECT utm_source, utm_medium, utm_campaign, utm_content, landing_page
      FROM   user_profiles WHERE email = ?
    `).get(email);

    expect(user.utm_source).toBe('facebook');
    expect(user.utm_medium).toBe('paid');
    expect(user.utm_campaign).toBe('prospecting_aug26');
    expect(user.utm_content).toBe('ad3_depth');
    expect(user.landing_page).toBe('/sign-up-a.html');
  }, 30000);

  test('an organic signup carries no attribution', async () => {
    const db    = getDb();
    const ag    = agent();
    const email = `organic_${Date.now()}@example.com`;

    await ag.get('/sign-up-a.html');
    await ag.post('/auth/signup').send({ email, password: 'TestPass123!' });

    const row = await db.prepare(`
      SELECT ap.verify_token FROM auth_providers ap
      JOIN user_profiles up ON up.user_id = ap.user_id
      WHERE up.email = ?
    `).get(email);
    await ag.post('/auth/verify-email').send({ email, pin: row.verify_token });

    const user = await db.prepare(
      'SELECT utm_source, utm_campaign FROM user_profiles WHERE email = ?'
    ).get(email);
    expect(user.utm_source).toBeNull();
    expect(user.utm_campaign).toBeNull();
  }, 30000);
});

// ---------------------------------------------------------------------------
// The exactly-once CompleteRegistration gate
// ---------------------------------------------------------------------------
describe('Signup conversion — POST /api/events/signup-conversion', () => {
  test('fires exactly once, then never again', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);

    const first = await ag.post('/api/events/signup-conversion');
    expect(first.status).toBe(200);
    expect(first.body.fire).toBe(true);

    // Every subsequent call — page reload, second device, cleared storage.
    const second = await ag.post('/api/events/signup-conversion');
    expect(second.body.fire).toBe(false);

    const third = await ag.post('/api/events/signup-conversion');
    expect(third.body.fire).toBe(false);
  });

  test('concurrent calls produce a single fire', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => ag.post('/api/events/signup-conversion'))
    );

    const fired = results.filter(r => r.body.fire === true);
    expect(fired).toHaveLength(1);
  });

  test('returns the campaign so the pixel event carries the winning angle', async () => {
    const db   = getDb();
    const user = await createUser();
    await db.prepare(`
      UPDATE user_profiles
      SET utm_source = 'facebook', utm_campaign = 'prospecting_aug26', utm_content = 'ad2_consistency'
      WHERE user_id = ?
    `).run(user.userId);

    const ag  = await loginAs(user);
    const res = await ag.post('/api/events/signup-conversion');

    expect(res.body.fire).toBe(true);
    expect(res.body.utm_campaign).toBe('prospecting_aug26');
    expect(res.body.utm_content).toBe('ad2_consistency');
  });

  test('never fires for a user already marked as registered', async () => {
    const db   = getDb();
    const user = await createUser();
    // Mirrors migration 079's backfill of every pre-existing user.
    await db.prepare(
      'UPDATE user_profiles SET signup_conversion_fired_at = now() WHERE user_id = ?'
    ).run(user.userId);

    const ag  = await loginAs(user);
    const res = await ag.post('/api/events/signup-conversion');
    expect(res.body.fire).toBe(false);
  });

  test('rejects an unauthenticated caller', async () => {
    const res = await agent().post('/api/events/signup-conversion');
    expect(res.status).toBe(401);
  });
});

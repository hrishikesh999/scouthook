'use strict';

const { getDb, createUser, loginAs, truncateAll } = require('./helpers/setup');

afterEach(truncateAll);

// ---------------------------------------------------------------------------
// POST /api/profile/starter — the two questions /start asks before anything else.
//
// These fields were empty on 21 of 21 workspaces created in the fortnight before
// this shipped, which left the AUDIENCE RESONANCE block in the generator prompt
// with nothing to bite on. The tests below pin the two properties that matter:
// the write lands in the tables the generator actually reads, and a partial
// re-submit cannot blank a field the author already filled.
// ---------------------------------------------------------------------------
describe('POST /api/profile/starter', () => {
  async function defaultProfileId(db, user) {
    const row = await db.prepare(
      'SELECT id FROM profiles WHERE workspace_id = ? AND is_default = true LIMIT 1'
    ).get(user.workspaceId);
    return row?.id;
  }

  async function readBack(db, profileId) {
    const brand = await db.prepare(
      'SELECT brand_description FROM brand_voice_profiles WHERE profile_id = ?'
    ).get(profileId);
    const audience = await db.prepare(
      'SELECT audience_description FROM audience_profiles WHERE profile_id = ?'
    ).get(profileId);
    return {
      brand:    brand?.brand_description    || null,
      audience: audience?.audience_description || null,
    };
  }

  test('writes both fields to the tables the generator reads', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const db   = getDb();

    const res = await ag.post('/api/profile/starter').send({
      expertise: 'I help B2B SaaS founders fix their onboarding emails',
      audience:  'Early-stage founders',
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const saved = await readBack(db, await defaultProfileId(db, user));
    expect(saved.brand).toBe('I help B2B SaaS founders fix their onboarding emails');
    expect(saved.audience).toBe('Early-stage founders');
  });

  test('a partial re-submit does not blank the other field', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const db   = getDb();

    await ag.post('/api/profile/starter').send({
      expertise: 'Sales coaching for technical founders',
      audience:  'Seed-stage CTOs',
    });

    // Returning to /start and filling only one box must not wipe the other —
    // the upserts COALESCE for exactly this case.
    const res = await ag.post('/api/profile/starter').send({
      expertise: 'Sales coaching for founders who hate selling',
    });
    expect(res.status).toBe(200);

    const saved = await readBack(db, await defaultProfileId(db, user));
    expect(saved.brand).toBe('Sales coaching for founders who hate selling');
    expect(saved.audience).toBe('Seed-stage CTOs');
  });

  test('rejects a submit with nothing usable in it', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);

    const res = await ag.post('/api/profile/starter').send({ expertise: '   ', audience: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('nothing_to_save');
  });

  test('truncates oversized input rather than rejecting it', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const db   = getDb();

    const res = await ag.post('/api/profile/starter').send({
      expertise: 'x'.repeat(1000),
      audience:  'Founders',
    });
    expect(res.status).toBe(200);

    const saved = await readBack(db, await defaultProfileId(db, user));
    expect(saved.brand).toHaveLength(300);
  });

  test('requires an authenticated session', async () => {
    const { agent } = require('./helpers/setup');
    const res = await agent().post('/api/profile/starter').send({
      expertise: 'Anything',
      audience:  'Anyone',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

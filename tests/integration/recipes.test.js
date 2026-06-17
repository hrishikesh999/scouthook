'use strict';

const { agent, createUser, loginAs, truncateAll } = require('./helpers/setup');

afterEach(truncateAll);

describe('Recipes — GET /', () => {
  test('returns 401 without session', async () => {
    const res = await agent().get('/api/recipes');
    expect(res.status).toBe(401);
  });

  test('returns ok:true with recipes object', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/recipes');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // recipes is grouped by category — may be empty for test tenants
    expect(typeof res.body.recipes).toBe('object');
  });
});

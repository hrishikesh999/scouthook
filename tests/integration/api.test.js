'use strict';

const { createUser, loginAs, truncateAll } = require('./helpers/setup');

afterEach(truncateAll);

describe('API — dashboard endpoints', () => {
  test('GET /api/checklist returns ok:true with steps array', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/checklist');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.steps)).toBe(true);
    expect(res.body.steps.length).toBeGreaterThan(0);
  });

  test('GET /api/stats returns ok:true', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/stats');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('GET /api/posts/mix-recommendation returns ok:true', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/posts/mix-recommendation');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('GET /api/funnel/health returns ok:true', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/funnel/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('API — workspaces', () => {
  test('GET /api/workspaces returns the created workspace', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/workspaces');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.workspaces)).toBe(true);
    expect(res.body.workspaces.some(w => w.id === user.workspaceId)).toBe(true);
  });

  test('GET /api/workspaces/profiles returns profiles for workspace', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/workspaces/profiles');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.profiles)).toBe(true);
    expect(res.body.profiles.length).toBe(1);
  });

  test('GET /api/workspaces/:id/members returns owner', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get(`/api/workspaces/${user.workspaceId}/members`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.members.some(m => m.user_id === user.userId)).toBe(true);
  });
});

describe('API — posts', () => {
  test('GET /api/posts returns ok:true', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/posts');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('GET /api/posts?status=draft returns empty posts array for new user', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/posts?status=draft');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.posts).toEqual([]);
  });

  test('GET /api/posts/recent returns ok:true', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/posts/recent');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('PATCH /api/posts/:id/type for non-existent post returns 404', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.patch('/api/posts/999999/type').send({ post_type: 'reach' });
    expect(res.status).toBe(404);
  });
});

describe('API — vault', () => {
  test('GET /api/vault/documents returns ok:true with empty list', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/vault/documents');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.documents)).toBe(true);
  });

  test('GET /api/vault/ideas returns ok:true', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/vault/ideas');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('API — profile', () => {
  test('GET /api/profile returns ok:true with profile data', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/profile');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('POST /api/profile with no fields returns 400', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/profile').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_fields_provided');
  });
});

describe('API — LinkedIn', () => {
  test('GET /api/linkedin/status returns ok:true', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/linkedin/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('GET /api/linkedin/connections returns ok:true with empty list', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/linkedin/connections');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('API — billing', () => {
  test('GET /api/billing/config returns ok:true', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/billing/config');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('GET /api/billing/subscription returns plan for user', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/billing/subscription');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

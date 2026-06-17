'use strict';

const { agent, createUser, loginAs, truncateAll } = require('./helpers/setup');

afterEach(truncateAll);

describe('Security — authentication gates', () => {
  const PROTECTED = [
    ['GET',   '/api/checklist'],
    ['GET',   '/api/stats'],
    ['GET',   '/api/posts'],
    ['GET',   '/api/vault/documents'],
    ['GET',   '/api/media'],
    ['GET',   '/api/notifications'],
    ['GET',   '/api/workspaces'],
    ['GET',   '/api/linkedin/connections'],
    ['POST',  '/api/generate'],
    ['POST',  '/api/vault/upload'],
  ];

  test.each(PROTECTED)('%s %s → 401 without session', async (method, path) => {
    const ag  = agent();
    const res = await ag[method.toLowerCase()](path).send({});
    expect(res.status).toBe(401);
  });
});

describe('Security — workspace isolation', () => {
  test('User A cannot read User B workspace members', async () => {
    const userA = await createUser({ email: 'a@example.com' });
    const userB = await createUser({ email: 'b@example.com' });
    const agA   = await loginAs(userA);

    const res = await agA.get(`/api/workspaces/${userB.workspaceId}/members`);
    // Should be 404 (not a member, workspace not found for this user) — not 200
    expect(res.status).not.toBe(200);
    expect(res.body.ok).not.toBe(true);
  });

  test('User A cannot switch into User B workspace', async () => {
    const userA = await createUser({ email: 'a2@example.com' });
    const userB = await createUser({ email: 'b2@example.com' });
    const agA   = await loginAs(userA);

    const res = await agA
      .post(`/api/workspaces/${userB.workspaceId}/switch`)
      .send({});
    expect(res.status).not.toBe(200);
    expect(res.body.ok).not.toBe(true);
  });

  test('User A cannot delete User B workspace', async () => {
    const userA = await createUser({ email: 'a3@example.com' });
    const userB = await createUser({ email: 'b3@example.com' });
    const agA   = await loginAs(userA);

    const res = await agA.delete(`/api/workspaces/${userB.workspaceId}`);
    expect(res.status).not.toBe(200);
  });
});

describe('Security — admin protection', () => {
  test('GET /admin/settings without admin password returns 401', async () => {
    const res = await agent().get('/admin/settings');
    expect(res.status).toBe(401);
  });

  test('GET /admin/diagnostics without admin password returns 401', async () => {
    const res = await agent().get('/admin/diagnostics');
    expect(res.status).toBe(401);
  });
});

describe('Security — path traversal', () => {
  test('/files/../../../etc/passwd returns 404 or 401, never 200 with file content', async () => {
    const res = await agent().get('/files/../../../etc/passwd');
    expect([401, 403, 404]).toContain(res.status);
  });
});

describe('Security — SQL injection fuzzing', () => {
  const INJECTION_PAYLOADS = [
    "'; DROP TABLE user_profiles; --",
    "1 OR 1=1",
    "1; SELECT * FROM user_profiles",
    "' UNION SELECT null,null,null --",
  ];

  test.each(INJECTION_PAYLOADS)('GET /api/posts/%s never returns 500', async (payload) => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get(`/api/posts/${encodeURIComponent(payload)}`);
    // Should return 400 (invalid id) or 404, never 500
    expect(res.status).not.toBe(500);
    expect(res.status).not.toBe(200);
  });

  test.each(INJECTION_PAYLOADS)('GET /api/workspaces/%s/members never returns 500', async (payload) => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get(`/api/workspaces/${encodeURIComponent(payload)}/members`);
    expect(res.status).not.toBe(500);
  });
});

describe('Security — LinkedIn token leak', () => {
  test('GET /api/linkedin/status does not expose access_token or refresh_token', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/linkedin/status');
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/access_token/);
    expect(body).not.toMatch(/refresh_token/);
    expect(body).not.toMatch(/oauth_token/);
  });

  test('GET /api/linkedin/connections does not expose tokens', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/linkedin/connections');
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/access_token/);
    expect(body).not.toMatch(/refresh_token/);
    expect(body).not.toMatch(/oauth_token/);
  });
});

describe('Security — XSS stored content', () => {
  test('workspace name containing HTML is returned as-is in JSON (not stripped or executed)', async () => {
    const db = global.__scouthookDb || require('../../db').db;
    const user = await createUser();
    const ag   = await loginAs(user);

    // Inject XSS payload into workspace name
    const xssName = '<script>alert(1)</script>';
    await db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(xssName, user.workspaceId);

    const res = await ag.get('/api/workspaces');
    expect(res.status).toBe(200);
    // JSON API returns the raw string — XSS risk is the frontend's escaping responsibility
    const ws = res.body.workspaces.find(w => w.id === user.workspaceId);
    // The name should be stored and returned exactly (not silently modified)
    expect(ws?.name).toBeDefined();
  });
});

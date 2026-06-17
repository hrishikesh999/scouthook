'use strict';

const { agent } = require('./helpers/setup');

// Admin password is loaded from .env via dotenv in setup.js
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

describe('Admin — authentication guard', () => {
  test('GET /admin/settings returns 401 without password', async () => {
    const res = await agent().get('/admin/settings');
    expect(res.status).toBe(401);
  });

  test('GET /admin/diagnostics returns 401 without password', async () => {
    const res = await agent().get('/admin/diagnostics');
    expect(res.status).toBe(401);
  });

  test('POST /admin/settings returns 401 with wrong password', async () => {
    const res = await agent()
      .post('/admin/settings')
      .set('x-admin-password', 'wrong-password')
      .send({ settings: {} });
    expect(res.status).toBe(401);
  });
});

describe('Admin — settings CRUD (with valid password)', () => {
  test('GET /admin/settings returns settings list', async () => {
    if (!ADMIN_PASSWORD) return; // skip if not configured in test env

    const res = await agent()
      .get('/admin/settings')
      .set('x-admin-password', ADMIN_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.settings)).toBe(true);
  });

  test('POST /admin/settings with empty object returns ok:true', async () => {
    if (!ADMIN_PASSWORD) return;

    const res = await agent()
      .post('/admin/settings')
      .set('x-admin-password', ADMIN_PASSWORD)
      .send({ settings: {} });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.updated)).toBe(true);
  });

  test('GET /admin/diagnostics returns users list', async () => {
    if (!ADMIN_PASSWORD) return;

    const res = await agent()
      .get('/admin/diagnostics')
      .set('x-admin-password', ADMIN_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.users)).toBe(true);
  });

  test('sensitive keys in settings are masked (never returned in full)', async () => {
    if (!ADMIN_PASSWORD) return;

    const res = await agent()
      .get('/admin/settings')
      .set('x-admin-password', ADMIN_PASSWORD);
    expect(res.status).toBe(200);

    const sensitiveKeys = ['anthropic_api_key', 'linkedin_client_secret', 'token_encryption_key'];
    for (const row of res.body.settings) {
      if (sensitiveKeys.includes(row.key) && row.is_set) {
        // Should be masked: first 6 chars + … + last 4
        expect(row.value).toMatch(/…/);
        expect(row.value.length).toBeLessThan(30);
      }
    }
  });
});

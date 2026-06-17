'use strict';

const request = require('supertest');
const { getApp, agent, createUser, loginAs, truncateAll } = require('./helpers/setup');

afterEach(truncateAll);

describe('Auth — email signup + login', () => {
  test('POST /auth/login returns 400 on invalid email format', async () => {
    const res = await agent().post('/auth/login').send({ email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('POST /auth/login returns 401 for unknown user', async () => {
    const res = await agent().post('/auth/login').send({ email: 'nobody@example.com', password: 'TestPass123!' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  test('POST /auth/login returns 401 for wrong password', async () => {
    const user = await createUser();
    const res  = await agent().post('/auth/login').send({ email: user.email, password: 'WrongPass999!' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  test('POST /auth/login succeeds with correct credentials', async () => {
    const user = await createUser();
    const res  = await agent().post('/auth/login').send({ email: user.email, password: user.password });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('GET /api/auth/me returns user after login', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.user_id).toBe(user.userId);
  });

  test('GET /api/auth/me returns user:null without session', async () => {
    const res = await agent().get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user).toBeNull();
  });

  test('POST /auth/logout clears session — subsequent /me returns user:null', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    await ag.post('/auth/logout');
    const res = await ag.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });
});

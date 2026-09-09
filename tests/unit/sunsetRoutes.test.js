'use strict';

// Proves the gates are actually wired into the routes, not merely present in
// lib/accessControl. Every assertion here is a request that must be refused
// BEFORE any database work — which is also why this file can safely point
// DATABASE_URL at a dead address: if a gate ever stops short-circuiting, the
// test fails loudly instead of quietly reaching a real database.

process.env.DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:1/nonexistent';
process.env.NODE_ENV = 'test';
delete process.env.SUNSET_MODE;
delete process.env.ACCESS_ALLOWLIST;
process.env.SIGNUP_SECRET = 'test-key-abc';

const express   = require('express');
const request   = require('supertest');
const authRoutes = require('../../routes/email-auth');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/auth', authRoutes);
  return a;
}

describe('sunset gates are wired into the auth routes', () => {
  test('a locked-out user gets 403 sunset, not an invalid-password error', async () => {
    const res = await request(app())
      .post('/auth/login')
      .send({ email: 'someone@else.com', password: 'whatever-long-enough' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'sunset' });
  });

  test('signup without the key is refused', async () => {
    const res = await request(app())
      .post('/auth/signup')
      .send({ name: 'Nobody', email: 'nobody@else.com', password: 'whatever-long-enough' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'signup_closed' });
  });

  test('signup with the wrong key is refused', async () => {
    const res = await request(app())
      .post('/auth/signup?key=wrong')
      .send({ name: 'Nobody', email: 'nobody@else.com', password: 'whatever-long-enough' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'signup_closed' });
  });

  test('the operator is let through the login gate — it fails later, at the database', async () => {
    // Not a 403: the gate passed and the handler proceeded to look the user up,
    // which is exactly the behaviour we want. The dead DATABASE_URL turns that
    // lookup into a 500, which proves the request got past the gate.
    const res = await request(app())
      .post('/auth/login')
      .send({ email: 'rishi@copypower.co', password: 'whatever-long-enough' });
    expect(res.status).not.toBe(403);
  });

  test('signup with the right key gets past the gate too', async () => {
    const res = await request(app())
      .post('/auth/signup?key=test-key-abc')
      .send({ name: 'Nobody', email: 'nobody@else.com', password: 'whatever-long-enough' });
    expect(res.status).not.toBe(403);
  });
});

'use strict';

require('dotenv').config();
const crypto = require('crypto');
const { agent, createUser, loginAs, truncateAll } = require('./helpers/setup');

afterEach(truncateAll);

async function createInvite({ workspaceId, invitedBy, email, role = 'editor' }) {
  const db = global.__scouthookDb || require('../../db').db;
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare(`
    INSERT INTO workspace_invites (workspace_id, email, role, token, invited_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(workspaceId, email, role, token, invitedBy, expiresAt);
  return token;
}

describe('Invites — GET /:token', () => {
  test('returns 404 for unknown token', async () => {
    const res = await agent().get('/api/invites/nonexistent-token-xyz');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('invite_not_found_or_expired');
  });

  test('returns workspace info for valid token', async () => {
    const owner = await createUser({ email: 'owner@example.com' });
    const token = await createInvite({
      workspaceId: owner.workspaceId,
      invitedBy: owner.userId,
      email: 'invitee@example.com',
    });

    const res = await agent().get(`/api/invites/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.workspace_name).toBeDefined();
    expect(res.body.role).toBe('editor');
    expect(res.body.email_hint).toMatch(/\*\*\*/);
  });
});

describe('Invites — POST /:token/accept', () => {
  test('returns 401 without auth', async () => {
    const res = await agent().post('/api/invites/some-token/accept').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('not_authenticated');
  });

  test('returns 404 for non-existent token when authenticated', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/invites/nonexistent-token/accept').send({});
    expect(res.status).toBe(404);
  });

  test('returns 403 when logged-in email does not match invite email', async () => {
    const owner   = await createUser({ email: 'owner2@example.com' });
    const invitee = await createUser({ email: 'invitee2@example.com' });
    const token = await createInvite({
      workspaceId: owner.workspaceId,
      invitedBy: owner.userId,
      email: 'different@example.com',
    });

    const ag  = await loginAs(invitee);
    const res = await ag.post(`/api/invites/${token}/accept`).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('email_mismatch');
  });

  test('returns ok:true when email matches and joins workspace', async () => {
    const owner   = await createUser({ email: 'owner3@example.com' });
    const invitee = await createUser({ email: 'invitee3@example.com' });
    const token = await createInvite({
      workspaceId: owner.workspaceId,
      invitedBy: owner.userId,
      email: 'invitee3@example.com',
    });

    const ag  = await loginAs(invitee);
    const res = await ag.post(`/api/invites/${token}/accept`).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.workspace_id).toBe(owner.workspaceId);
  });
});

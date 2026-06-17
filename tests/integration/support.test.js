'use strict';

const { agent, createUser, loginAs, truncateAll } = require('./helpers/setup');

afterEach(truncateAll);

describe('Support — POST /', () => {
  test('returns 401 without session', async () => {
    const res = await agent().post('/api/support').send({ topic: 'Billing', message: 'help' });
    expect(res.status).toBe(401);
  });

  test('returns 400 for missing topic', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/support').send({ message: 'help' });
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid topic', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/support').send({ topic: 'Invalid', message: 'help' });
    expect(res.status).toBe(400);
  });

  test('returns 400 for missing message', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/support').send({ topic: 'Billing' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when message exceeds 2000 chars', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/support').send({ topic: 'Other', message: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
  });

  test('returns ok:true for valid support request', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/support').send({
      topic: 'Billing',
      message: 'I have a question about my invoice.',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test.each(['LinkedIn connection', 'Publishing issue', 'Scheduling', 'Billing', 'Other'])(
    'accepts topic "%s"',
    async (topic) => {
      const user = await createUser();
      const ag   = await loginAs(user);
      const res  = await ag.post('/api/support').send({ topic, message: 'Test message' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }
  );
});

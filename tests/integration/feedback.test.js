'use strict';

const { createUser, loginAs, truncateAll } = require('./helpers/setup');

afterEach(truncateAll);

describe('Feedback — POST /', () => {
  test('returns 401 without session', async () => {
    const { agent } = require('./helpers/setup');
    const res = await agent().post('/api/feedback').send({ message: 'test' });
    expect(res.status).toBe(401);
  });

  test('returns 400 when message is missing', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/feedback').send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('returns 400 when message is empty string', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/feedback').send({ message: '   ' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when message exceeds 2000 chars', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/feedback').send({ message: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
  });

  test('returns 400 for rating outside 1–5', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/feedback').send({ message: 'Great tool!', rating: 6 });
    expect(res.status).toBe(400);
  });

  test('saves feedback with valid message and returns ok:true', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/feedback').send({
      message: 'This is a great tool!',
      rating: 5,
      category: 'feature_request',
      title: 'Feature idea',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('saves feedback without optional fields', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/feedback').send({ message: 'Simple feedback' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

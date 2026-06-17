'use strict';

const { createUser, loginAs, truncateAll } = require('./helpers/setup');

afterEach(truncateAll);

describe('Notifications — GET /', () => {
  test('returns empty notifications list for new user', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.notifications)).toBe(true);
    expect(res.body.notifications).toHaveLength(0);
  });
});

describe('Notifications — POST /read', () => {
  test('mark all read returns ok:true', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/notifications/read').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('mark single notification by id returns ok:true (even for non-existent id)', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/notifications/read').send({ id: 999999 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

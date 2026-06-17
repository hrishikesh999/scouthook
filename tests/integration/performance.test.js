'use strict';

const { createUser, loginAs, truncateAll } = require('./helpers/setup');

afterEach(truncateAll);

describe('Performance — GET /api/posts/performance-summary', () => {
  test('returns ok:true with enough_data:false for new user', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/posts/performance-summary');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.enough_data).toBe(false);
    expect(res.body.total_tagged).toBe(0);
  });
});

describe('Performance — POST /api/posts/:postId/performance', () => {
  test('returns 400 for invalid tag', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/posts/1/performance').send({ tag: 'invalid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_tag');
  });

  test('returns 400 for non-numeric postId', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/posts/not-a-number/performance').send({ tag: 'strong' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_id');
  });

  test('returns 404 for non-existent post with valid tag', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/posts/999999/performance').send({ tag: 'strong' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('post_not_found');
  });
});

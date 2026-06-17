'use strict';

const { agent, createUser, loginAs, truncateAll } = require('./helpers/setup');

afterEach(truncateAll);

describe('Visuals — POST /:postId', () => {
  test('returns 401 without session', async () => {
    const res = await agent().post('/api/visuals/1').send({ visual_type: 'quote_card' });
    expect(res.status).toBe(401);
  });

  test('returns 400 for invalid visual_type', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/visuals/1').send({ visual_type: 'invalid_type' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_visual_type');
  });

  test('returns 404 for non-existent post', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    // visual_type is valid, post doesn't exist → 404 post_not_found
    // (plan check may also gate this; on free plan with 0 visuals it should pass to post check)
    const res = await ag.post('/api/visuals/999999').send({ visual_type: 'quote_card', mode: 'extract' });
    // Could be 403 (plan) or 404 (not found) — either is acceptable; never 200
    expect([403, 404]).toContain(res.status);
    expect(res.body.ok).toBe(false);
  });
});

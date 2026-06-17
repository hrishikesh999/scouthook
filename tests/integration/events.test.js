'use strict';

const { createUser, loginAs, truncateAll } = require('./helpers/setup');

afterEach(truncateAll);

describe('Events — POST /copy', () => {
  test('records copy event — always returns ok:true', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/events/copy').send({
      post_id: 1,
      run_id: 'test-run',
      path: 'idea',
      format_slug: 'short',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('returns ok:true with empty body (fire-and-forget)', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/events/copy').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

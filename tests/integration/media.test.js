'use strict';

const { agent, createUser, loginAs, truncateAll } = require('./helpers/setup');

afterEach(truncateAll);

describe('Media — GET /', () => {
  test('returns 401 without session', async () => {
    const res = await agent().get('/api/media');
    expect(res.status).toBe(401);
  });

  test('returns empty files list for new user', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.get('/api/media');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.files)).toBe(true);
    expect(res.body.files).toHaveLength(0);
  });
});

describe('Media — POST /upload (validation)', () => {
  test('returns 400 when filename header is missing', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag
      .post('/api/media/upload')
      .set('Content-Type', 'image/png')
      .send(Buffer.from('fakeimagecontent'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_fields');
  });

  test('returns 400 for disallowed MIME type', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag
      .post('/api/media/upload')
      .set('Content-Type', 'text/html')
      .set('X-Filename', encodeURIComponent('test.html'))
      .send(Buffer.from('<html>test</html>'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_file_type');
  });

  test('returns 400 for empty body', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag
      .post('/api/media/upload')
      .set('Content-Type', 'image/png')
      .set('X-Filename', encodeURIComponent('empty.png'))
      .send(Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('empty_body');
  });
});

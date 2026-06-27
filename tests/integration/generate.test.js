'use strict';

require('dotenv').config();
const { createUser, loginAs, truncateAll } = require('./helpers/setup');

afterEach(truncateAll);

describe('Generate — validation gates (no Anthropic call)', () => {
  test('returns 400 missing_path when path is not provided', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/generate').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_path');
  });

  test('returns 400 missing_raw_idea when path provided but raw_idea is empty', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/generate').send({ path: 'idea' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_raw_idea');
  });

  test('returns 400 complete_profile_first when no default profile exists', async () => {
    const user = await createUser();
    // Remove the default profile so resolveProfile returns null
    const db = process.__scouthookDb || require('../../db').db;
    await db.prepare('DELETE FROM profiles WHERE workspace_id = ?').run(user.workspaceId);

    const ag  = await loginAs(user);
    const res = await ag.post('/api/generate').send({ path: 'idea', raw_idea: 'Some idea' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('complete_profile_first');
  });

  test('returns 403 feature_not_available for carousel on expired plan', async () => {
    const user = await createUser();
    const ag   = await loginAs(user);
    const res  = await ag.post('/api/generate').send({ path: 'idea', asset_type: 'carousel', raw_idea: 'test' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('feature_not_available');
    expect(res.body.feature).toBe('carousel');
  });
});

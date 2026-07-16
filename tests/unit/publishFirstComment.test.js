'use strict';

// First-comment regression tests. The comment API call must:
//  - hit the unversioned v2 socialActions endpoint (the versioned
//    /rest/socialActions API is partner-gated Community Management; a
//    consumer w_member_social token gets 403 there — the original bug),
//  - include the `object` field (the post URN) in the body,
//  - throw on 429/5xx so BullMQ retries (status stays 'pending'),
//  - mark 'failed' + log a scheduled_post_events row on definitive 4xx.

const dbCalls = { runs: [] };

jest.mock('../../db', () => ({
  db: {
    prepare: jest.fn(sql => ({
      get: jest.fn(async () => {
        if (sql.includes('FROM scheduled_posts')) {
          return {
            linkedin_post_id: 'urn:li:share:123',
            first_comment: 'hello from the comments',
            first_comment_status: 'pending',
            user_id: 'u1',
            tenant_id: 't1',
            profile_id: null,
          };
        }
        if (sql.includes('FROM linkedin_connections')) {
          return {
            id: 1,
            account_type: 'personal',
            linkedin_member_id: 'MEMBER1',
            organization_id: null,
            access_token_enc: 'enc',
            refresh_token_enc: null,
            expires_at: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
          };
        }
        return null;
      }),
      run: jest.fn(async (...args) => {
        dbCalls.runs.push({ sql, args });
        return { changes: 1 };
      }),
      all: jest.fn(async () => []),
    })),
  },
  getSetting: jest.fn(async () => null),
  getSettingSync: jest.fn(() => null),
}));

jest.mock('../../services/linkedinOAuth', () => ({
  encrypt: jest.fn(x => x),
  decrypt: jest.fn(() => 'plain-token'),
  fetchLinkedInPhotoUrl: jest.fn(),
  cacheLinkedInAvatar: jest.fn(),
}));

jest.mock('../../emails', () => ({ sendEmailToUser: jest.fn(async () => {}) }));

const { publishFirstComment } = require('../../services/linkedinPublisher');

describe('publishFirstComment', () => {
  let fetchMock;
  beforeEach(() => {
    dbCalls.runs = [];
    fetchMock = jest.fn(async () => ({ ok: true, status: 201, text: async () => '' }));
    global.fetch = fetchMock;
  });

  test('posts via v2 socialActions (not versioned /rest/) with object field', async () => {
    await publishFirstComment(9);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.linkedin.com/v2/socialActions/urn%3Ali%3Ashare%3A123/comments');
    expect(url).not.toContain('/rest/');
    expect(opts.headers['LinkedIn-Version']).toBeUndefined();
    const body = JSON.parse(opts.body);
    expect(body).toEqual({
      actor: 'urn:li:person:MEMBER1',
      object: 'urn:li:share:123',
      message: { text: 'hello from the comments' },
    });

    // success path marks 'posted'
    const posted = dbCalls.runs.find(c => c.sql.includes("first_comment_status = 'posted'"));
    expect(posted).toBeDefined();
  });

  test('throws on 429 without marking failed (BullMQ retries)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => 'throttled' });
    await expect(publishFirstComment(9)).rejects.toThrow('first_comment_transient_429');
    const failed = dbCalls.runs.find(c => c.sql.includes("first_comment_status = 'failed'"));
    expect(failed).toBeUndefined();
  });

  test('marks failed and logs event on 403', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'ACCESS_DENIED' });
    await publishFirstComment(9);
    const failed = dbCalls.runs.find(c => c.sql.includes("first_comment_status = 'failed'"));
    expect(failed).toBeDefined();
    const event = dbCalls.runs.find(c => c.sql.includes("'first_comment_failed'"));
    expect(event).toBeDefined();
    expect(event.args.join(' ')).toContain('403 ACCESS_DENIED');
  });
});

'use strict';

/**
 * LinkedIn scope parsing.
 *
 * The two ends of one OAuth handshake use different separators: we send scopes
 * space-separated on the authorization request, and LinkedIn echoes what it
 * granted comma-separated on the token response. We store the token response, so
 * a parser that only knew about whitespace read every freshly granted connection
 * as read-only — publishing stayed blocked no matter how many times the user
 * reconnected, because each reconnect stored the same unreadable string.
 */

const {
  parseScopes,
  normaliseScopes,
  connectionCanPublish,
} = require('../../services/linkedinPublisher');

// Exactly as LinkedIn's token endpoint returns it.
const GRANTED_FROM_TOKEN_RESPONSE = 'openid,profile,w_member_social';
// Exactly as we send it on the authorization request, and now store it.
const GRANTED_CANONICAL = 'openid profile w_member_social';

describe('parseScopes', () => {
  test('splits the comma-separated form LinkedIn returns', () => {
    expect(parseScopes(GRANTED_FROM_TOKEN_RESPONSE))
      .toEqual(['openid', 'profile', 'w_member_social']);
  });

  test('splits the space-separated form we send', () => {
    expect(parseScopes(GRANTED_CANONICAL))
      .toEqual(['openid', 'profile', 'w_member_social']);
  });

  test('tolerates the mixed and padded forms in between', () => {
    expect(parseScopes(' openid, profile ,  w_member_social '))
      .toEqual(['openid', 'profile', 'w_member_social']);
  });

  test('empty and null are no scopes, not a phantom one', () => {
    expect(parseScopes('')).toEqual([]);
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes(undefined)).toEqual([]);
  });
});

describe('normaliseScopes', () => {
  test('stores the comma form as the canonical space form', () => {
    expect(normaliseScopes(GRANTED_FROM_TOKEN_RESPONSE)).toBe(GRANTED_CANONICAL);
  });

  test('leaves an already-canonical value untouched', () => {
    expect(normaliseScopes(GRANTED_CANONICAL)).toBe(GRANTED_CANONICAL);
  });
});

describe('connectionCanPublish', () => {
  test('the bug: comma-separated grant is publish-capable', () => {
    expect(connectionCanPublish({ scopes: GRANTED_FROM_TOKEN_RESPONSE })).toBe(true);
  });

  test('space-separated grant is publish-capable', () => {
    expect(connectionCanPublish({ scopes: GRANTED_CANONICAL })).toBe(true);
  });

  test('a genuine read-only connection still cannot publish, either separator', () => {
    expect(connectionCanPublish({ scopes: 'openid,profile' })).toBe(false);
    expect(connectionCanPublish({ scopes: 'openid profile' })).toBe(false);
  });

  test('null scopes stay publish-capable — pre-082 rows must not be locked out', () => {
    expect(connectionCanPublish({ scopes: null })).toBe(true);
    expect(connectionCanPublish({})).toBe(true);
  });

  test('a scope that merely contains the string is not the scope', () => {
    expect(connectionCanPublish({ scopes: 'w_member_social_feed' })).toBe(false);
  });
});

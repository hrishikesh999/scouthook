'use strict';

/**
 * Recognising a dead LinkedIn token — pure classification, no DB, no network.
 *
 * This is the layer that failed in production. LinkedIn answered a publish with
 * 401 REVOKED_ACCESS_TOKEN, nothing recognised it as an auth failure, and the raw
 * response body was rendered to the user in red text while the connection went on
 * reporting itself as healthy. Every case below is "would we have caught it".
 */

const { classifyAuthFailure, throwIfAuthFailure, isReconnectRequired } =
  require('../../services/linkedinHealth');

describe('classifyAuthFailure', () => {
  test('recognises the exact body production returned', () => {
    // Copied from a real failed publish — the one that started this fix.
    const body = '{"status":401,"serviceErrorCode":65601,"code":"REVOKED_ACCESS_TOKEN","message":"The token used in the request has been revoked by the user"}';
    expect(classifyAuthFailure(401, body)).toBe('revoked');
  });

  test('recognises an expired token', () => {
    const body = '{"status":401,"serviceErrorCode":65600,"code":"EXPIRED_ACCESS_TOKEN","message":"The token used in the request has expired"}';
    expect(classifyAuthFailure(401, body)).toBe('expired');
  });

  test('falls back to the numeric code when no string code is present', () => {
    expect(classifyAuthFailure(401, '{"status":401,"serviceErrorCode":65601}')).toBe('revoked');
    expect(classifyAuthFailure(401, '{"status":401,"serviceErrorCode":65600}')).toBe('expired');
  });

  test('a 401 with an unparseable body still counts', () => {
    // The status alone is enough to know the token will not work. Requiring a
    // recognised code would put us back to guessing.
    expect(classifyAuthFailure(401, 'Unauthorized')).toBe('unauthorized');
    expect(classifyAuthFailure(401, '')).toBe('unauthorized');
  });

  test('does NOT fire on failures that are not about the token', () => {
    // Flagging these would tell healthy users to reconnect because LinkedIn was
    // rate-limiting us or having a bad day — worse than the bug being fixed.
    expect(classifyAuthFailure(403, '{"code":"ACCESS_DENIED"}')).toBeNull();
    expect(classifyAuthFailure(429, '{"message":"Too many requests"}')).toBeNull();
    expect(classifyAuthFailure(500, 'Internal Server Error')).toBeNull();
    expect(classifyAuthFailure(422, '{"message":"bad payload"}')).toBeNull();
  });
});

describe('throwIfAuthFailure', () => {
  test('throws a normalised reconnect_required carrying the reason', () => {
    expect.assertions(3);
    try {
      throwIfAuthFailure(401, '{"code":"REVOKED_ACCESS_TOKEN"}');
    } catch (err) {
      expect(err.message).toBe('reconnect_required');
      expect(err.linkedinAuthReason).toBe('revoked');
      expect(isReconnectRequired(err)).toBe(true);
    }
  });

  test('is a no-op for non-auth failures, so real errors keep their own message', () => {
    expect(() => throwIfAuthFailure(500, 'boom')).not.toThrow();
    expect(() => throwIfAuthFailure(429, '')).not.toThrow();
  });

  test('does not mistake an unrelated error for a reconnect', () => {
    expect(isReconnectRequired(new Error('linkedin_api_version_error'))).toBe(false);
    expect(isReconnectRequired(null)).toBe(false);
  });
});

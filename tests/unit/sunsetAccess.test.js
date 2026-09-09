'use strict';

// Sunset mode gates. The product is closed to everyone but the operator, so
// these assertions are the access-control contract: if one of them regresses,
// the app is open to people it should not be.

const path = require('path');
const MODULE = path.join(__dirname, '../../lib/accessControl');

// The module reads env at call time, not at require time — that is what lets
// the allowlist change without a redeploy. So env must stay set while the
// assertions run; afterEach puts it back.
const SAVED = { ...process.env };

afterEach(() => { process.env = { ...SAVED }; });

function freshModule(env) {
  jest.resetModules();
  for (const k of ['SUNSET_MODE', 'ACCESS_ALLOWLIST', 'SIGNUP_SECRET']) delete process.env[k];
  Object.assign(process.env, env);
  return require(MODULE);
}

describe('sunset access control', () => {
  test('the operator can sign in', () => {
    expect(freshModule({}).isAllowedEmail('rishi@copypower.co')).toBe(true);
  });

  test('email comparison ignores case and surrounding space', () => {
    expect(freshModule({}).isAllowedEmail('  RISHI@CopyPower.CO  ')).toBe(true);
  });

  test('every other user is locked out', () => {
    const a = freshModule({});
    expect(a.isAllowedEmail('someone@else.com')).toBe(false);
    expect(a.isAllowedEmail('')).toBe(false);
    expect(a.isAllowedEmail(null)).toBe(false);
    expect(a.isAllowedEmail(undefined)).toBe(false);
  });

  test('the allowlist is extensible without a deploy', () => {
    const a = freshModule({ ACCESS_ALLOWLIST: 'rishi@copypower.co, second@copypower.co' });
    expect(a.isAllowedEmail('second@copypower.co')).toBe(true);
    expect(a.isAllowedEmail('third@copypower.co')).toBe(false);
  });

  test('an empty allowlist falls back to the operator, never to open access', () => {
    const a = freshModule({ ACCESS_ALLOWLIST: '   ,  , ' });
    expect(a.isAllowedEmail('rishi@copypower.co')).toBe(true);
    expect(a.isAllowedEmail('someone@else.com')).toBe(false);
  });

  test('signup stays closed while SIGNUP_SECRET is unset — a missing var must fail safe', () => {
    const a = freshModule({});
    expect(a.signupSecretOk('anything')).toBe(false);
    expect(a.signupSecretOk(undefined)).toBe(false);
  });

  test('signup opens only for the exact key', () => {
    const a = freshModule({ SIGNUP_SECRET: 'correct-horse' });
    expect(a.signupSecretOk('correct-horse')).toBe(true);
    expect(a.signupSecretOk(' correct-horse ')).toBe(true);
    expect(a.signupSecretOk('correct-hors')).toBe(false);
    expect(a.signupSecretOk('')).toBe(false);
    expect(a.signupSecretOk(null)).toBe(false);
  });

  test('sunset is the default — only an explicit off reopens the product', () => {
    expect(freshModule({}).sunsetActive()).toBe(true);
    expect(freshModule({ SUNSET_MODE: 'anything-else' }).sunsetActive()).toBe(true);
    const open = freshModule({ SUNSET_MODE: 'off' });
    expect(open.sunsetActive()).toBe(false);
    expect(open.isAllowedEmail('someone@else.com')).toBe(true);
    expect(open.signupSecretOk(undefined)).toBe(true);
  });
});

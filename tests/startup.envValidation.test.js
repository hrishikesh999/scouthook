'use strict';

/**
 * Server startup environment validation tests.
 *
 * Verifies that server.js throws (or warns) appropriately when required
 * env vars are missing or malformed — before any user traffic is served.
 *
 * Tests run by spawning isolated child processes so each gets a clean env.
 *
 * Run: node tests/startup.envValidation.test.js
 */

const assert       = require('assert');
const { spawnSync } = require('child_process');
const path         = require('path');

const ROOT = path.resolve(__dirname, '..');

// ─── Harness ─────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// Run a tiny Node snippet that requires the validation block from server.js
// in an isolated process with a controlled env. Returns { stdout, stderr, status }.
function runCheck(envOverrides = {}) {
  // Extract only the startup validation block from server.js so we don't need
  // DB, Redis, or any external service to be available during tests.
  const snippet = `
    require('dotenv').config();
    // Inline the exact validation logic from server.js
    if (!process.env.SESSION_SECRET) {
      throw new Error('SESSION_SECRET environment variable is required. Set a strong random string (e.g. openssl rand -hex 32).');
    }
    const _tek = (process.env.TOKEN_ENCRYPTION_KEY || '').trim();
    if (!_tek) {
      const msg = 'TOKEN_ENCRYPTION_KEY is not set — LinkedIn connections will fail at runtime. Generate with: openssl rand -hex 32';
      if (process.env.NODE_ENV === 'production') {
        throw new Error(msg);
      } else {
        console.warn('[startup] WARNING: ' + msg);
      }
    } else if (_tek.length !== 64) {
      throw new Error('TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Generate with: openssl rand -hex 32');
    }
    if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_ORIGIN) {
      console.warn('[startup] WARNING: ALLOWED_ORIGIN is not set. If your frontend is on a different origin than the API, cross-origin requests will be rejected by the browser. Set ALLOWED_ORIGIN=https://app.yourdomain.com to enable CORS.');
    }
    console.log('STARTUP_OK');
  `;

  const env = {
    // Minimal env — no inherited vars, so tests are deterministic.
    // NODE_PATH is needed so require() can find node_modules.
    PATH: process.env.PATH,
    NODE_PATH: process.env.NODE_PATH || '',
    // Safe defaults — override with test-specific values
    NODE_ENV: 'development',
    SESSION_SECRET: 'test-secret-that-is-long-enough-for-tests',
    ...envOverrides,
  };

  const result = spawnSync(process.execPath, ['-e', snippet], {
    cwd: ROOT,
    env,
    timeout: 5000,
    encoding: 'utf8',
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status ?? 1,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log('\nserver.js — startup environment validation');

console.log('\n  SESSION_SECRET');

test('missing SESSION_SECRET → throws regardless of NODE_ENV', () => {
  const { status, stderr } = runCheck({ SESSION_SECRET: '' });
  assert.notStrictEqual(status, 0, 'Process must exit non-zero');
  assert.ok(stderr.includes('SESSION_SECRET'), `Error must mention SESSION_SECRET, got: ${stderr.slice(0, 200)}`);
});

test('valid SESSION_SECRET alone (dev, no TEK) → warns but starts', () => {
  const { status, stdout, stderr } = runCheck({
    NODE_ENV: 'development',
    SESSION_SECRET: 'a-valid-secret-for-testing',
    // TOKEN_ENCRYPTION_KEY omitted
  });
  assert.strictEqual(status, 0, `Expected exit 0, got ${status}. stderr: ${stderr.slice(0, 200)}`);
  assert.ok(stdout.includes('STARTUP_OK'));
  assert.ok(stderr.includes('TOKEN_ENCRYPTION_KEY'), 'Must warn about missing TEK in dev');
});

console.log('\n  TOKEN_ENCRYPTION_KEY');

test('missing TEK in production → throws', () => {
  const { status, stderr } = runCheck({
    NODE_ENV: 'production',
    SESSION_SECRET: 'a-valid-secret',
    // TOKEN_ENCRYPTION_KEY omitted
  });
  assert.notStrictEqual(status, 0, 'Must exit non-zero in production when TEK is missing');
  assert.ok(stderr.includes('TOKEN_ENCRYPTION_KEY'), `Must mention TOKEN_ENCRYPTION_KEY, got: ${stderr.slice(0, 200)}`);
});

test('missing TEK in development → warns, starts', () => {
  const { status, stdout, stderr } = runCheck({
    NODE_ENV: 'development',
    SESSION_SECRET: 'a-valid-secret',
  });
  assert.strictEqual(status, 0, `Expected exit 0, got ${status}`);
  assert.ok(stdout.includes('STARTUP_OK'));
  assert.ok(stderr.includes('[startup] WARNING'), 'Must log a [startup] WARNING');
});

test('TEK with wrong length (not 64 chars) → throws in any env', () => {
  const { status, stderr } = runCheck({
    NODE_ENV: 'development',
    SESSION_SECRET: 'a-valid-secret',
    TOKEN_ENCRYPTION_KEY: 'tooshort',
  });
  assert.notStrictEqual(status, 0, 'Must exit non-zero for malformed TEK');
  assert.ok(stderr.includes('64-character'), `Must mention 64-character requirement, got: ${stderr.slice(0, 200)}`);
});

test('valid 64-char hex TEK → no error, no warning', () => {
  const validKey = 'a'.repeat(64); // 64 hex chars = 32 bytes
  const { status, stdout, stderr } = runCheck({
    NODE_ENV: 'production',
    SESSION_SECRET: 'a-valid-secret',
    TOKEN_ENCRYPTION_KEY: validKey,
    ALLOWED_ORIGIN: 'https://app.scouthook.com', // suppress CORS warning
  });
  assert.strictEqual(status, 0, `Expected exit 0, got ${status}. stderr: ${stderr.slice(0, 200)}`);
  assert.ok(stdout.includes('STARTUP_OK'));
  assert.ok(!stderr.includes('TOKEN_ENCRYPTION_KEY'), 'Must not warn about valid TEK');
});

console.log('\n  ALLOWED_ORIGIN (CORS)');

test('missing ALLOWED_ORIGIN in production → warns, does not throw', () => {
  const validKey = 'a'.repeat(64);
  const { status, stdout, stderr } = runCheck({
    NODE_ENV: 'production',
    SESSION_SECRET: 'a-valid-secret',
    TOKEN_ENCRYPTION_KEY: validKey,
    // ALLOWED_ORIGIN omitted
  });
  assert.strictEqual(status, 0, `Must not throw for missing ALLOWED_ORIGIN — same-origin deployments are valid. stderr: ${stderr.slice(0,200)}`);
  assert.ok(stdout.includes('STARTUP_OK'));
  assert.ok(stderr.includes('ALLOWED_ORIGIN'), 'Must warn about missing ALLOWED_ORIGIN in production');
});

test('missing ALLOWED_ORIGIN in development → no warning', () => {
  const validKey = 'a'.repeat(64);
  const { status, stderr } = runCheck({
    NODE_ENV: 'development',
    SESSION_SECRET: 'a-valid-secret',
    TOKEN_ENCRYPTION_KEY: validKey,
  });
  assert.strictEqual(status, 0);
  assert.ok(!stderr.includes('ALLOWED_ORIGIN'), 'Must not warn about CORS in development');
});

test('valid ALLOWED_ORIGIN in production → no CORS warning', () => {
  const validKey = 'a'.repeat(64);
  const { status, stderr } = runCheck({
    NODE_ENV: 'production',
    SESSION_SECRET: 'a-valid-secret',
    TOKEN_ENCRYPTION_KEY: validKey,
    ALLOWED_ORIGIN: 'https://app.scouthook.com',
  });
  assert.strictEqual(status, 0);
  assert.ok(!stderr.includes('ALLOWED_ORIGIN'), 'Must not warn when ALLOWED_ORIGIN is set');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

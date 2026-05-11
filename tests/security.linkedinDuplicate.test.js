'use strict';

/**
 * LinkedIn duplicate-account check tests.
 *
 * Verifies the OAuth callback blocks connecting a LinkedIn profile that is
 * already claimed by a different ScoutHook user, while allowing:
 *   - first-time connections
 *   - the same user reconnecting their own account
 *   - connections where linkedin_user_id is unavailable (API failure)
 *
 * Tests the logic directly (not the full OAuth flow) by extracting the
 * duplicate-check query and redirect behaviour from the callback handler.
 *
 * Run: node tests/security.linkedinDuplicate.test.js
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const ROOT = path.resolve(__dirname, '..');

// ─── Harness ─────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ─── Duplicate-check logic extracted for unit testing ────────────────────────
//
// Rather than spinning up the full OAuth flow (which requires Redis, LinkedIn
// API mocks, etc.), we extract and test the duplicate-check decision logic
// directly. This is the exact conditional added to routes/linkedin.js.

async function runDuplicateCheck({ db, linkedin_user_id, userId, tenantId, stateData }) {
  // Mirrors the code in routes/linkedin.js exactly
  if (linkedin_user_id) {
    const claimed = await db.prepare(
      'SELECT user_id FROM linkedin_tokens WHERE linkedin_user_id = ? AND tenant_id = ?'
    ).get(linkedin_user_id, tenantId);

    if (claimed && claimed.user_id !== userId) {
      const errBase = stateData?.returnTo?.split('?')[0] || '/account.html';
      return { blocked: true, redirectTo: `${errBase}?linkedin_error=linkedin_already_connected` };
    }
  }
  return { blocked: false };
}

function makeDb(claimedUserId = null) {
  const calls = [];
  return {
    prepare: (sql) => ({
      get: async (...args) => {
        calls.push({ sql, args });
        return claimedUserId ? { user_id: claimedUserId } : null;
      },
    }),
    _calls: calls,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function main() {

console.log('\nroutes/linkedin.js — duplicate LinkedIn account check');

await test('new connection (no existing claim) → allowed', async () => {
  const db = makeDb(null); // no existing row
  const result = await runDuplicateCheck({
    db,
    linkedin_user_id: 'li_abc123',
    userId:    'google:user_a',
    tenantId:  'tenant_a',
    stateData: { returnTo: '/account.html' },
  });
  assert.strictEqual(result.blocked, false);
  // DB was queried to confirm no existing claim
  assert.ok(db._calls.some(c => c.sql.includes('linkedin_tokens')), 'Must query linkedin_tokens');
});

await test('same user reconnecting own account → allowed', async () => {
  // linkedin_user_id already exists but claimed by the SAME user
  const db = makeDb('google:user_a');
  const result = await runDuplicateCheck({
    db,
    linkedin_user_id: 'li_abc123',
    userId:    'google:user_a',  // same as claimedUserId
    tenantId:  'tenant_a',
    stateData: { returnTo: '/account.html' },
  });
  assert.strictEqual(result.blocked, false, 'Same user reconnecting must not be blocked');
});

await test('different user trying to claim already-connected LinkedIn account → blocked', async () => {
  const db = makeDb('google:user_b'); // user_b already owns this LinkedIn account
  const result = await runDuplicateCheck({
    db,
    linkedin_user_id: 'li_abc123',
    userId:    'google:user_a',  // attacker / second user
    tenantId:  'tenant_a',
    stateData: { returnTo: '/account.html' },
  });
  assert.strictEqual(result.blocked, true, 'Duplicate connection must be blocked');
  assert.ok(
    result.redirectTo.includes('linkedin_error=linkedin_already_connected'),
    `Redirect must include linkedin_already_connected error, got: ${result.redirectTo}`
  );
});

await test('blocked redirect preserves returnTo base path', async () => {
  const db = makeDb('google:user_b');
  const result = await runDuplicateCheck({
    db,
    linkedin_user_id: 'li_abc123',
    userId:    'google:user_a',
    tenantId:  'tenant_a',
    stateData: { returnTo: '/preview.html?post_id=42' }, // has query string
  });
  assert.strictEqual(result.blocked, true);
  // Must use base path only (strip existing query string), then append error
  assert.ok(result.redirectTo.startsWith('/preview.html?'), `Expected /preview.html base, got: ${result.redirectTo}`);
  assert.ok(!result.redirectTo.includes('post_id=42'), 'Stale query params from returnTo must be stripped');
  assert.ok(result.redirectTo.includes('linkedin_error=linkedin_already_connected'));
});

await test('null linkedin_user_id (API failure) → check skipped, no redirect', async () => {
  const db = makeDb('google:user_b'); // would block if check ran
  const result = await runDuplicateCheck({
    db,
    linkedin_user_id: null, // LinkedIn API didn't return the ID
    userId:    'google:user_a',
    tenantId:  'tenant_a',
    stateData: { returnTo: '/account.html' },
  });
  assert.strictEqual(result.blocked, false, 'Null linkedin_user_id must skip the check');
  assert.strictEqual(db._calls.length, 0, 'DB must not be queried when linkedin_user_id is null');
});

await test('empty string linkedin_user_id → check skipped (falsy)', async () => {
  const db = makeDb('google:user_b');
  const result = await runDuplicateCheck({
    db,
    linkedin_user_id: '',
    userId:    'google:user_a',
    tenantId:  'tenant_a',
    stateData: { returnTo: '/account.html' },
  });
  assert.strictEqual(result.blocked, false);
  assert.strictEqual(db._calls.length, 0);
});

await test('error key in source matches frontend handler (linkedin_already_connected)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/linkedin.js'), 'utf8');
  assert.ok(
    src.includes('linkedin_error=linkedin_already_connected'),
    'Backend must redirect with linkedin_error=linkedin_already_connected to match frontend handler'
  );
  const frontendSrc = fs.readFileSync(path.join(ROOT, 'public/account.html'), 'utf8');
  assert.ok(
    frontendSrc.includes("err === 'linkedin_already_connected'"),
    'Frontend must handle linkedin_already_connected error key'
  );
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

}

main().catch(err => { console.error(err); process.exit(1); });

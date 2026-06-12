'use strict';

/**
 * LinkedIn duplicate-account check tests.
 *
 * Verifies the OAuth callback's workspace-scoped duplicate check:
 *   - Blocks a different user from connecting the same LinkedIn within the SAME workspace
 *   - Allows the same user to reconnect their own account
 *   - Allows the same LinkedIn to be connected in a DIFFERENT workspace (cross-workspace sharing)
 *   - Skips the check when linkedin_member_id is unavailable (API failure)
 *
 * Tests the logic directly against the current linkedin_connections schema
 * (linkedin_tokens was dropped in migration 036).
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
// Mirrors the workspace-scoped check in routes/linkedin.js callback.
// The check queries linkedin_connections (not the dropped linkedin_tokens table).

async function runDuplicateCheck({ db, linkedin_member_id, userId, tenantId, stateData }) {
  if (linkedin_member_id) {
    const claimed = await db.prepare(
      `SELECT authorized_by FROM linkedin_connections WHERE workspace_id = ? AND account_key = ?`
    ).get(tenantId, 'person_' + linkedin_member_id);

    if (claimed && claimed.authorized_by !== userId) {
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
        return claimedUserId ? { authorized_by: claimedUserId } : null;
      },
    }),
    _calls: calls,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function main() {

console.log('\nroutes/linkedin.js — duplicate LinkedIn account check (workspace-scoped)');

await test('new connection (no existing claim in workspace) → allowed', async () => {
  const db = makeDb(null);
  const result = await runDuplicateCheck({
    db,
    linkedin_member_id: 'li_abc123',
    userId:    'google:user_a',
    tenantId:  'workspace_a',
    stateData: { returnTo: '/account.html' },
  });
  assert.strictEqual(result.blocked, false);
  assert.ok(
    db._calls.some(c => c.sql.includes('linkedin_connections')),
    'Must query linkedin_connections (not the dropped linkedin_tokens table)'
  );
});

await test('same user reconnecting own account in same workspace → allowed', async () => {
  const db = makeDb('google:user_a');
  const result = await runDuplicateCheck({
    db,
    linkedin_member_id: 'li_abc123',
    userId:    'google:user_a',
    tenantId:  'workspace_a',
    stateData: { returnTo: '/account.html' },
  });
  assert.strictEqual(result.blocked, false, 'Same user reconnecting must not be blocked');
});

await test('different user, same workspace, already-connected LinkedIn → blocked', async () => {
  const db = makeDb('google:user_b'); // user_b already owns this LinkedIn in workspace_a
  const result = await runDuplicateCheck({
    db,
    linkedin_member_id: 'li_abc123',
    userId:    'google:user_a',  // different user, same workspace
    tenantId:  'workspace_a',
    stateData: { returnTo: '/account.html' },
  });
  assert.strictEqual(result.blocked, true, 'Different user in same workspace must be blocked');
  assert.ok(
    result.redirectTo.includes('linkedin_error=linkedin_already_connected'),
    `Redirect must include linkedin_already_connected error, got: ${result.redirectTo}`
  );
});

await test('same LinkedIn, different workspace → allowed (cross-workspace sharing)', async () => {
  // workspace_b has NO existing row for this linkedin_member_id — makeDb returns null
  const db = makeDb(null);
  const result = await runDuplicateCheck({
    db,
    linkedin_member_id: 'li_abc123',
    userId:    'google:user_b',
    tenantId:  'workspace_b',   // different workspace from where user_a connected
    stateData: { returnTo: '/account.html' },
  });
  assert.strictEqual(result.blocked, false, 'Same LinkedIn in a different workspace must be allowed');
});

await test('blocked redirect preserves returnTo base path', async () => {
  const db = makeDb('google:user_b');
  const result = await runDuplicateCheck({
    db,
    linkedin_member_id: 'li_abc123',
    userId:    'google:user_a',
    tenantId:  'workspace_a',
    stateData: { returnTo: '/preview.html?post_id=42' },
  });
  assert.strictEqual(result.blocked, true);
  assert.ok(result.redirectTo.startsWith('/preview.html?'), `Expected /preview.html base, got: ${result.redirectTo}`);
  assert.ok(!result.redirectTo.includes('post_id=42'), 'Stale query params from returnTo must be stripped');
  assert.ok(result.redirectTo.includes('linkedin_error=linkedin_already_connected'));
});

await test('null linkedin_member_id (API failure) → check skipped, no redirect', async () => {
  const db = makeDb('google:user_b'); // would block if check ran
  const result = await runDuplicateCheck({
    db,
    linkedin_member_id: null,
    userId:    'google:user_a',
    tenantId:  'workspace_a',
    stateData: { returnTo: '/account.html' },
  });
  assert.strictEqual(result.blocked, false, 'Null linkedin_member_id must skip the check');
  assert.strictEqual(db._calls.length, 0, 'DB must not be queried when linkedin_member_id is null');
});

await test('empty string linkedin_member_id → check skipped (falsy)', async () => {
  const db = makeDb('google:user_b');
  const result = await runDuplicateCheck({
    db,
    linkedin_member_id: '',
    userId:    'google:user_a',
    tenantId:  'workspace_a',
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

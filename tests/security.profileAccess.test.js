'use strict';

/**
 * Profile route access-control tests.
 *
 * Verifies that GET /api/profile/:user_id ignores the URL param and uses only
 * the authenticated session identity — so no user can read another user's profile.
 *
 * Run: node tests/security.profileAccess.test.js
 */

const assert  = require('assert');
const http    = require('http');
const express = require('express');
const path    = require('path');

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

function makeRequest(server, urlPath, { userId, tenantId } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (userId)   headers['x-test-user']   = userId;
    if (tenantId) headers['x-test-tenant'] = tenantId;

    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      method: 'GET',
      path: urlPath,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function startServer(app) {
  return new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function stopServer(s) {
  return new Promise(resolve => s.close(resolve));
}

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function makeMockDb(profileResult = null) {
  const calls = [];
  return {
    db: {
      prepare: (sql) => ({
        get:  async (...args) => { calls.push({ sql, args }); return profileResult; },
        run:  async (...args) => { calls.push({ sql, args }); return { changes: 0, lastInsertRowid: 0 }; },
        all:  async (...args) => { calls.push({ sql, args }); return []; },
      }),
      transaction: (fn) => fn({ prepare: (sql) => ({ run: async (...args) => ({ changes: 0 }) }) }),
    },
    getSetting: async () => null,
    getSettingSync: () => null,
    _calls: calls,
  };
}

function inject(relPath, exports) {
  const abs = require.resolve(path.join(ROOT, relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

function evict(relPath) {
  delete require.cache[require.resolve(path.join(ROOT, relPath))];
}

function loadRouter(relPath) {
  evict(relPath);
  return require(path.join(ROOT, relPath));
}

function authMiddleware(req, res, next) {
  // Simulates passport session: userId from x-test-user header (test only)
  req.userId   = req.headers['x-test-user']   || null;
  req.tenantId = req.headers['x-test-tenant'] || 'tenant_a';
  next();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function main() {

console.log('\nroutes/profile.js — GET /:user_id');

await test('unauthenticated request → 401, no DB access', async () => {
  const mock = makeMockDb(null);
  inject('./db', mock);
  const app = express().use(express.json()).use(authMiddleware).use('/api/profile', loadRouter('./routes/profile'));
  const server = await startServer(app);
  try {
    // Pass a real-looking user_id in the URL — server must ignore it
    const res = await makeRequest(server, '/api/profile/google:victim123');
    assert.strictEqual(res.status, 401, `expected 401 got ${res.status}`);
    assert.strictEqual(res.body.error, 'unauthenticated');
    assert.strictEqual(mock._calls.length, 0, 'DB must not be queried for unauthenticated request');
  } finally {
    await stopServer(server);
  }
});

await test('user A cannot read user B\'s profile via URL param — session identity wins', async () => {
  // user_b's profile
  const userBProfile = {
    audience_role: 'B\'s audience', audience_pain: null, content_niche: 'B\'s niche',
    contrarian_view: null, voice_fingerprint: null, writing_samples: null,
    brand_bg: null, brand_accent: null, brand_text: null, brand_name: null, brand_logo: null,
    user_role: null, onboarding_complete: 0, business_positioning: null, website_url: null,
  };
  const mock = makeMockDb(userBProfile);
  inject('./db', mock);

  const app = express().use(express.json()).use(authMiddleware).use('/api/profile', loadRouter('./routes/profile'));
  const server = await startServer(app);
  try {
    // Attacker is authenticated as user_a but puts user_b's id in the URL
    const res = await makeRequest(server, '/api/profile/google:user_b', {
      userId:   'google:user_a',   // session identity
      tenantId: 'tenant_a',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);

    // Confirm the DB was queried with user_a (session), not user_b (URL param)
    const profileQuery = mock._calls.find(c => c.sql.includes('user_profiles'));
    assert.ok(profileQuery, 'Profile query must have been made');
    assert.ok(
      profileQuery.args.includes('google:user_a'),
      `DB query must use session userId "google:user_a", not URL param. Args: ${JSON.stringify(profileQuery.args)}`
    );
    assert.ok(
      !profileQuery.args.includes('google:user_b'),
      `DB query must NOT use URL param "google:user_b". Args: ${JSON.stringify(profileQuery.args)}`
    );
  } finally {
    await stopServer(server);
  }
});

await test('authenticated user reads their own profile — correct user_id used', async () => {
  const ownProfile = {
    audience_role: 'Founders', audience_pain: 'No time', content_niche: 'SaaS growth',
    contrarian_view: 'Cold email is dead', voice_fingerprint: '{"fp":true}', writing_samples: 'Sample text',
    brand_bg: '#fff', brand_accent: '#000', brand_text: '#333', brand_name: 'Acme', brand_logo: null,
    user_role: 'founder', onboarding_complete: 1, business_positioning: 'We help SaaS founders', website_url: 'https://example.com',
  };
  const mock = makeMockDb(ownProfile);
  inject('./db', mock);

  const app = express().use(express.json()).use(authMiddleware).use('/api/profile', loadRouter('./routes/profile'));
  const server = await startServer(app);
  try {
    const res = await makeRequest(server, '/api/profile/google:user_a', {
      userId: 'google:user_a', tenantId: 'tenant_a',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.ok(res.body.profile, 'Profile must be returned');
    assert.strictEqual(res.body.profile.user_role, 'founder');
    // voice_fingerprint must not be leaked — only has_fingerprint boolean
    assert.strictEqual(res.body.profile.has_fingerprint, true);
    assert.strictEqual(res.body.profile.voice_fingerprint, undefined, 'Raw fingerprint must not be in response');
  } finally {
    await stopServer(server);
  }
});

await test('authenticated user with no profile → returns null gracefully', async () => {
  const mock = makeMockDb(null); // no profile row
  inject('./db', mock);

  const app = express().use(express.json()).use(authMiddleware).use('/api/profile', loadRouter('./routes/profile'));
  const server = await startServer(app);
  try {
    const res = await makeRequest(server, '/api/profile/google:new_user', {
      userId: 'google:new_user', tenantId: 'tenant_a',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.profile, null);
  } finally {
    await stopServer(server);
  }
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

}

main().catch(err => { console.error(err); process.exit(1); });

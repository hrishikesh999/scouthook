'use strict';

/**
 * Cross-user data leak security tests.
 *
 * Tests that routes/visuals.js, routes/media.js, and routes/stats.js
 * correctly enforce user ownership — no data leaks between accounts.
 *
 * Runs without a real DB or external services. All dependencies are
 * injected into require.cache before routes are loaded.
 *
 * Run: node tests/security.crossUserLeak.test.js
 */

const assert = require('assert');
const http   = require('http');
const express = require('express');
const path   = require('path');
const fs     = require('fs');

// ─── Test harness ────────────────────────────────────────────────────────────

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

function makeRequest(server, method, urlPath, { userId, tenantId, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (userId)   headers['x-test-user']   = userId;
    if (tenantId) headers['x-test-tenant'] = tenantId;

    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      method, path: urlPath, headers,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
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

// ─── Mock DB factory ─────────────────────────────────────────────────────────
//
// Records every prepare(sql).get/run/all call so tests can assert on args.
// Per-query results keyed by a SQL substring.

function makeMockDb(resultsMap = {}) {
  const calls = [];

  function stmt(sql) {
    return {
      get:  async (...args) => { const r = resolve(sql, 'get',  args); calls.push({ sql, op: 'get',  args, result: r }); return r; },
      run:  async (...args) => { const r = resolve(sql, 'run',  args); calls.push({ sql, op: 'run',  args, result: r }); return r ?? { changes: 0, lastInsertRowid: 0 }; },
      all:  async (...args) => { const r = resolve(sql, 'all',  args); calls.push({ sql, op: 'all',  args, result: r }); return r ?? []; },
    };
  }

  function resolve(sql, op, args) {
    for (const [fragment, val] of Object.entries(resultsMap)) {
      if (sql.includes(fragment)) {
        return typeof val === 'function' ? val(sql, op, args) : val;
      }
    }
    return null;
  }

  function transaction(fn) {
    return fn({ prepare: stmt });
  }

  return { db: { prepare: stmt, transaction }, _calls: calls };
}

// ─── require.cache injection helpers ─────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');

function inject(relPath, exports) {
  const abs = require.resolve(path.join(ROOT, relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

function evict(relPath) {
  const abs = require.resolve(path.join(ROOT, relPath));
  delete require.cache[abs];
}

function loadRouter(relPath) {
  evict(relPath);
  return require(path.join(ROOT, relPath));
}

// Auth middleware used by all test apps
function authMiddleware(req, res, next) {
  req.userId   = req.headers['x-test-user']   || null;
  req.tenantId = req.headers['x-test-tenant'] || 'tenant_a';
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: routes/visuals.js
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nroutes/visuals.js');

// Common mocks for visuals — overridden per test where needed
const noopVisualServices = {
  './services/storage': {
    buildKey: () => 'key',
    download: async () => Buffer.from(''),
  },
  './services/quoteCardGenerator': {
    generateQuoteCard: async () => ({}),
    extractQuoteCardContent: async () => ({ quote: 'x' }),
    renderQuoteCard: async () => ({ fileUrl: '/files/out.png', previewUrl: null }),
  },
  './services/carouselGenerator': {
    generateCarousel: async () => ({}),
    extractCarouselContent: async () => ({ slides: [] }),
    renderCarousel: async () => ({ fileUrl: '/files/out.pdf', previewUrl: null }),
  },
  './services/brandedQuoteGenerator': {
    generateBrandedQuote: async () => ({}),
    extractBrandedQuoteContent: async () => ({ quote: 'x' }),
    renderBrandedQuote: async () => ({ fileUrl: '/files/out.png', previewUrl: null }),
  },
  './services/subscription': {
    canGenerateVisual: async () => ({ allowed: true }),
    logVisualGeneration: async () => {},
  },
};

await test('unauthenticated request → 401 (never touches DB)', async () => {
  const mock = makeMockDb({});
  inject('./db', { ...mock, getSetting: async () => null, getSettingSync: () => null });
  for (const [k, v] of Object.entries(noopVisualServices)) inject(k, v);

  const app = express().use(express.json()).use(authMiddleware).use('/api/visuals', loadRouter('./routes/visuals'));
  const server = await startServer(app);
  try {
    const res = await makeRequest(server, 'POST', '/api/visuals/42', {
      // no userId header → unauthenticated
      body: { visual_type: 'quote_card', mode: 'extract' },
    });
    assert.strictEqual(res.status, 401, `expected 401 got ${res.status}`);
    assert.strictEqual(res.body.error, 'unauthenticated');
    assert.strictEqual(mock._calls.length, 0, 'DB must NOT be called for unauthenticated request');
  } finally {
    await stopServer(server);
  }
});

await test('authenticated user A cannot access user B\'s post → 404', async () => {
  // DB returns null when user_id doesn't match → correct ownership check
  const mock = makeMockDb({ 'generated_posts': null });
  inject('./db', { ...mock, getSetting: async () => null, getSettingSync: () => null });
  for (const [k, v] of Object.entries(noopVisualServices)) inject(k, v);

  const app = express().use(express.json()).use(authMiddleware).use('/api/visuals', loadRouter('./routes/visuals'));
  const server = await startServer(app);
  try {
    const res = await makeRequest(server, 'POST', '/api/visuals/99', {
      userId: 'user_a',
      body: { visual_type: 'quote_card', mode: 'extract' },
    });
    assert.strictEqual(res.status, 404, `expected 404 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.error, 'post_not_found');
  } finally {
    await stopServer(server);
  }
});

await test('SQL query for post includes user_id — verified in source', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/visuals.js'), 'utf8');
  const match = src.match(/SELECT \* FROM generated_posts WHERE id = \? AND user_id = \? AND tenant_id = \?/);
  assert.ok(match, 'generated_posts SELECT must include user_id = ? AND tenant_id = ?');
});

await test('authenticated correct user receives their post (extract mode, no image generated)', async () => {
  const mockPost = { id: 7, user_id: 'user_a', tenant_id: 'tenant_a', content: 'Test post content' };
  const mock = makeMockDb({
    'generated_posts': mockPost,
    'user_profiles': null, // no brand profile, uses defaults
    'linkedin_tokens': null,
  });
  inject('./db', { ...mock, getSetting: async () => null, getSettingSync: () => null });
  for (const [k, v] of Object.entries(noopVisualServices)) inject(k, v);

  const app = express().use(express.json()).use(authMiddleware).use('/api/visuals', loadRouter('./routes/visuals'));
  const server = await startServer(app);
  try {
    const res = await makeRequest(server, 'POST', '/api/visuals/7', {
      userId: 'user_a',
      body: { visual_type: 'quote_card', mode: 'extract' },
    });
    // extract mode succeeds — not 401 or 403
    assert.notStrictEqual(res.status, 401, 'Must not be 401 for authenticated user');
    assert.notStrictEqual(res.status, 403, 'Must not be 403 for correct user');
    assert.strictEqual(res.status, 200, `expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.ok, true);
  } finally {
    await stopServer(server);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: routes/media.js
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nroutes/media.js');

const noopMediaServices = {
  './services/storage': {
    buildKey: () => 'key',
    delete: async () => {},
    upload: async () => {},
    download: async () => Buffer.from('PNG'),
    copy: async () => {},
  },
};

await test('DELETE — file belongs to different user (SELECT returns null) → 404', async () => {
  const mock = makeMockDb({ 'media_files': null });
  inject('./db', { ...mock, getSetting: async () => null, getSettingSync: () => null });
  for (const [k, v] of Object.entries(noopMediaServices)) inject(k, v);

  const app = express().use(express.json()).use(authMiddleware).use('/api/media', loadRouter('./routes/media'));
  const server = await startServer(app);
  try {
    const res = await makeRequest(server, 'DELETE', '/api/media/55', { userId: 'user_a' });
    assert.strictEqual(res.status, 404, `expected 404 got ${res.status}`);
    assert.strictEqual(res.body.error, 'not_found');

    // Confirm no DELETE was attempted (only SELECT was called)
    const deleteCalls = mock._calls.filter(c => c.sql.startsWith('DELETE'));
    assert.strictEqual(deleteCalls.length, 0, 'DELETE must not run when file is not found');
  } finally {
    await stopServer(server);
  }
});

await test('DELETE — file belongs to correct user → storage deleted, DB deleted with user_id filter', async () => {
  const mockFile = { id: 55, stored_name: 'file_abc.png' };
  let deleteSqlCalled = null;
  let deleteArgsCalled = null;

  const mock = makeMockDb({
    'SELECT id': mockFile,
    'DELETE FROM media_files': (sql, op, args) => {
      deleteSqlCalled = sql;
      deleteArgsCalled = args;
      return { changes: 1 };
    },
  });
  inject('./db', { ...mock, getSetting: async () => null, getSettingSync: () => null });
  for (const [k, v] of Object.entries(noopMediaServices)) inject(k, v);

  const app = express().use(express.json()).use(authMiddleware).use('/api/media', loadRouter('./routes/media'));
  const server = await startServer(app);
  try {
    const res = await makeRequest(server, 'DELETE', '/api/media/55', {
      userId: 'user_a', tenantId: 'tenant_a',
    });
    assert.strictEqual(res.status, 200, `expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);

    // SQL must contain user_id and tenant_id filters
    assert.ok(deleteSqlCalled, 'DELETE SQL must have been called');
    assert.ok(deleteSqlCalled.includes('user_id'), `DELETE SQL missing user_id: "${deleteSqlCalled}"`);
    assert.ok(deleteSqlCalled.includes('tenant_id'), `DELETE SQL missing tenant_id: "${deleteSqlCalled}"`);

    // Second arg = userId, third arg = tenantId
    assert.strictEqual(deleteArgsCalled[1], 'user_a',   `DELETE arg[1] should be userId, got: ${deleteArgsCalled[1]}`);
    assert.strictEqual(deleteArgsCalled[2], 'tenant_a', `DELETE arg[2] should be tenantId, got: ${deleteArgsCalled[2]}`);
  } finally {
    await stopServer(server);
  }
});

await test('unauthenticated DELETE → 400', async () => {
  const mock = makeMockDb({});
  inject('./db', { ...mock, getSetting: async () => null, getSettingSync: () => null });
  for (const [k, v] of Object.entries(noopMediaServices)) inject(k, v);

  const app = express().use(express.json()).use(authMiddleware).use('/api/media', loadRouter('./routes/media'));
  const server = await startServer(app);
  try {
    const res = await makeRequest(server, 'DELETE', '/api/media/55'); // no userId
    assert.strictEqual(res.status, 400);
    assert.strictEqual(mock._calls.length, 0, 'DB must not be called for unauthenticated request');
  } finally {
    await stopServer(server);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: routes/stats.js — delete draft (copy_events scoping)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nroutes/stats.js');

await test('copy_events DELETE SQL includes user_id — verified in source', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/stats.js'), 'utf8');
  const match = src.match(/DELETE FROM copy_events WHERE post_id = \? AND user_id = \?/);
  assert.ok(match, 'copy_events DELETE must scope by user_id');
});

await test('delete draft — copy_events DELETE receives correct userId in args', async () => {
  let copyEventsDeleteArgs = null;

  const noopScheduler = { removeScheduledJob: async () => {} };
  inject('./services/scheduler', noopScheduler);

  const mock = makeMockDb({
    // Ownership check passes: post belongs to user_a
    'SELECT id, status FROM generated_posts': { id: 11, status: 'draft' },
    // No active scheduled post
    'scheduled_posts\n      WHERE post_id': null,
    // No scheduled rows to cancel
    'SELECT id FROM scheduled_posts': [],
    // Transaction inner queries
    'DELETE FROM scheduled_post_events': { changes: 0 },
    'DELETE FROM copy_events': (sql, op, args) => {
      copyEventsDeleteArgs = args;
      return { changes: 1 };
    },
    'DELETE FROM scheduled_posts': { changes: 0 },
    'DELETE FROM generated_posts': { changes: 1 },
  });
  inject('./db', { ...mock, getSetting: async () => null, getSettingSync: () => null });

  const app = express().use(express.json()).use(authMiddleware).use('/api', loadRouter('./routes/stats'));
  const server = await startServer(app);
  try {
    const res = await makeRequest(server, 'DELETE', '/api/posts/11', {
      userId: 'user_a', tenantId: 'tenant_a',
    });
    // The response may be 200 or 500 depending on transaction mock completeness,
    // but we care specifically that copy_events DELETE was called with the right user
    assert.ok(copyEventsDeleteArgs !== null, 'copy_events DELETE must have been called');
    assert.strictEqual(
      copyEventsDeleteArgs[1], 'user_a',
      `copy_events DELETE arg[1] should be userId "user_a", got: "${copyEventsDeleteArgs[1]}"`
    );
  } finally {
    await stopServer(server);
  }
});

await test('unauthenticated delete → 400, no DB access', async () => {
  const noopScheduler = { removeScheduledJob: async () => {} };
  inject('./services/scheduler', noopScheduler);
  const mock = makeMockDb({});
  inject('./db', { ...mock, getSetting: async () => null, getSettingSync: () => null });

  const app = express().use(express.json()).use(authMiddleware).use('/api', loadRouter('./routes/stats'));
  const server = await startServer(app);
  try {
    const res = await makeRequest(server, 'DELETE', '/api/posts/11'); // no userId
    assert.strictEqual(res.status, 400);
    assert.strictEqual(mock._calls.length, 0, 'DB must not be called for unauthenticated request');
  } finally {
    await stopServer(server);
  }
});

await test('user A cannot delete user B\'s post — DB returns null → 404', async () => {
  const noopScheduler = { removeScheduledJob: async () => {} };
  inject('./services/scheduler', noopScheduler);
  // SELECT returns null → post not found for this user
  const mock = makeMockDb({ 'SELECT id, status FROM generated_posts': null });
  inject('./db', { ...mock, getSetting: async () => null, getSettingSync: () => null });

  const app = express().use(express.json()).use(authMiddleware).use('/api', loadRouter('./routes/stats'));
  const server = await startServer(app);
  try {
    const res = await makeRequest(server, 'DELETE', '/api/posts/99', {
      userId: 'user_a', tenantId: 'tenant_a',
    });
    assert.strictEqual(res.status, 404, `expected 404 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.error, 'post_not_found');

    // Confirm no DELETE was attempted
    const deleteCalls = mock._calls.filter(c => c.sql.trim().startsWith('DELETE'));
    assert.strictEqual(deleteCalls.length, 0, 'No DELETE should run when post ownership check fails');
  } finally {
    await stopServer(server);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

} // end main

main().catch(err => { console.error(err); process.exit(1); });

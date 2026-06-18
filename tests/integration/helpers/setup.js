'use strict';

// Load .env.test so tests always hit the dedicated test database, never production.
require('dotenv').config({ path: '.env.test', override: true });

const request = require('supertest');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');

// Use process (not global) to share a single server + db instance across Jest's
// per-file VM contexts. Jest gives each test file its own VM sandbox, so `global`
// is NOT shared between files — but `process` is the real Node.js process object,
// identical across all VM contexts. Without this, each test file creates its own
// pg.Pool (max 30 connections), and 4+ concurrent pools exhaust Postgres's limit.
function getDb() {
  if (!process.__scouthookDb) {
    process.__scouthookDb = require('../../../db').db;
  }
  return process.__scouthookDb;
}

function getApp() {
  if (!process.__scouthookApp) {
    process.__scouthookApp = require('../../../server').app;
  }
  return process.__scouthookApp;
}

function agent() {
  return request.agent(getApp());
}

// ---------------------------------------------------------------------------
// Create a test user + workspace + profile, return ids + credentials
// ---------------------------------------------------------------------------
async function createUser(overrides = {}) {
  const email       = overrides.email       || `test_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`;
  const displayName = overrides.displayName || 'Test User';
  const password    = overrides.password    || 'TestPass123!';
  const userId      = `user_${crypto.randomUUID()}`;

  const db = getDb();

  await db.prepare(`
    INSERT INTO user_profiles (user_id, email, display_name)
    VALUES (?, ?, ?)
  `).run(userId, email, displayName);

  const credentialHash = await bcrypt.hash(password, 8);
  await db.prepare(`
    INSERT INTO auth_providers (user_id, provider, provider_id, credential_hash, verified_at)
    VALUES (?, 'email', ?, ?, NOW())
  `).run(userId, email, credentialHash);

  const wsId = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO workspaces (id, name, created_by, created_at)
    VALUES (?, ?, ?, NOW())
  `).run(wsId, `${displayName}'s Workspace`, userId);

  await db.prepare(`
    INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
    VALUES (?, ?, 'owner', NOW())
  `).run(wsId, userId);

  await db.prepare(`
    INSERT INTO profiles (workspace_id, profile_type, display_name, is_default, created_at, updated_at)
    VALUES (?, 'brand', ?, true, NOW(), NOW())
  `).run(wsId, displayName);

  return { userId, workspaceId: wsId, email, password, displayName };
}

// ---------------------------------------------------------------------------
// Log in and return an authenticated supertest agent (session cookie preserved)
// ---------------------------------------------------------------------------
async function loginAs(user) {
  const ag  = agent();
  const res = await ag
    .post('/auth/login')
    .send({ email: user.email, password: user.password });

  if (res.status !== 200) {
    throw new Error(`loginAs failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return ag;
}

// ---------------------------------------------------------------------------
// Truncate all user-data tables between tests
// ---------------------------------------------------------------------------
async function truncateAll() {
  // Hard safety guard — refuse to wipe data if DATABASE_URL looks like production.
  // The test Neon branch host contains 'withered-lab' (a known safe pattern).
  // TEST_DB_ALLOWED=true in .env.test is the explicit opt-in.
  const dbUrl = process.env.DATABASE_URL || '';
  const safe = /withered-lab|test|dev|local/i.test(dbUrl) || process.env.TEST_DB_ALLOWED === 'true';
  if (!safe) {
    throw new Error(
      '[truncateAll] REFUSED: DATABASE_URL does not look like a test database.\n' +
      'Point DATABASE_URL at the test Neon branch and set TEST_DB_ALLOWED=true in .env.test.'
    );
  }

  const db = getDb();
  await db.prepare(`
    TRUNCATE workspace_members, workspace_invites,
             profiles, linkedin_connections, generated_posts, scheduled_posts,
             scheduled_post_events, vault_documents, vault_chunks, vault_ideas,
             media_files, notifications, feedback, support_requests,
             auth_providers, workspaces, user_profiles
    RESTART IDENTITY CASCADE
  `).run();
}

module.exports = { getApp, agent, createUser, loginAs, truncateAll };

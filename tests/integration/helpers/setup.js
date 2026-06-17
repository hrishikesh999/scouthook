'use strict';

require('dotenv').config();

const request = require('supertest');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');

// Use global to share a single server + db instance across Jest's per-file module
// registries. Without this, each test file creates a new server + connection pool,
// exhausting PostgreSQL connections after ~10 files.
function getDb() {
  if (!global.__scouthookDb) {
    global.__scouthookDb = require('../../../db').db;
  }
  return global.__scouthookDb;
}

function getApp() {
  if (!global.__scouthookApp) {
    global.__scouthookApp = require('../../../server').app;
  }
  return global.__scouthookApp;
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

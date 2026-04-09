'use strict';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const backend = require('./db/pg');

// A small compatibility surface used by the codebase.
const db = {
  prepare: backend.prepare,
  transaction: backend.transaction,
  exec: backend.exec ? backend.exec : async sql => backend.query(sql),
};

async function getSetting(key) {
  try {
    const row = await backend.prepare('SELECT value FROM platform_settings WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

function getSettingSync(key) {
  return null;
}

async function setSetting(key, value) {
  return backend.prepare(
    'INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
  ).run(key, value);
}

async function getAllSettings() {
  return backend.prepare('SELECT key, value FROM platform_settings ORDER BY key').all();
}

async function getTenantSetting(tenantId, key) {
  try {
    const row = await backend.prepare(
      'SELECT value FROM tenant_settings WHERE tenant_id = ? AND key = ?'
    ).get(tenantId, key);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

async function setTenantSetting(tenantId, key, value) {
  return backend.prepare(
    'INSERT INTO tenant_settings (tenant_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
  ).run(tenantId, key, value);
}

module.exports = {
  db,
  backendKind: backend.kind,
  getSetting,
  getSettingSync,
  setSetting,
  getAllSettings,
  getTenantSetting,
  setTenantSetting,
};

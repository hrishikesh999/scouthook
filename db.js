'use strict';

const sqlite = require('./db/sqlite');
const pg = require('./db/pg');

const backend = process.env.DATABASE_URL ? pg : sqlite;

// A small compatibility surface used by the codebase.
// In Postgres mode, these methods are async.
const db = {
  prepare: backend.prepare,
  transaction: backend.transaction,
  exec: backend.exec ? backend.exec : async sql => backend.query(sql),
};

function _prepareSync(sql) {
  // Used only when backend is sqlite and callers expect sync behavior.
  // In sqlite adapter, prepare is async-wrapper already, so use raw db.
  return backend.kind === 'sqlite' ? backend.db.prepare(sql) : null;
}

const stmtGetSettingSync = _prepareSync('SELECT value FROM platform_settings WHERE key = ?');
const stmtSetSettingSync = _prepareSync(
  'INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
);
const stmtGetAllSettingsSync = _prepareSync('SELECT key, value FROM platform_settings ORDER BY key');

async function getSetting(key) {
  try {
    if (backend.kind === 'sqlite') {
      const row = stmtGetSettingSync.get(key);
      return row ? row.value : null;
    }
    const row = await backend.prepare('SELECT value FROM platform_settings WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

function getSettingSync(key) {
  if (backend.kind !== 'sqlite') return null;
  try {
    const row = stmtGetSettingSync.get(key);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

async function setSetting(key, value) {
  if (backend.kind === 'sqlite') return stmtSetSettingSync.run(key, value);
  return backend.prepare(
    'INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
  ).run(key, value);
}

async function getAllSettings() {
  if (backend.kind === 'sqlite') return stmtGetAllSettingsSync.all();
  return backend.prepare('SELECT key, value FROM platform_settings ORDER BY key').all();
}

const stmtGetTenantSettingSync = _prepareSync(
  'SELECT value FROM tenant_settings WHERE tenant_id = ? AND key = ?'
);
const stmtSetTenantSettingSync = _prepareSync(
  'INSERT INTO tenant_settings (tenant_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
);

async function getTenantSetting(tenantId, key) {
  try {
    if (backend.kind === 'sqlite') {
      const row = stmtGetTenantSettingSync.get(tenantId, key);
      return row ? row.value : null;
    }
    const row = await backend.prepare(
      'SELECT value FROM tenant_settings WHERE tenant_id = ? AND key = ?'
    ).get(tenantId, key);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

async function setTenantSetting(tenantId, key, value) {
  if (backend.kind === 'sqlite') return stmtSetTenantSettingSync.run(tenantId, key, value);
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

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function listMigrations(dir) {
  return fs.readdirSync(dir)
    .filter(f => /^\d+_.+\.sql$/.test(f))
    .sort((a, b) => a.localeCompare(b));
}

async function main() {
  const databaseUrl = mustEnv('DATABASE_URL');
  const migrationsDir = path.join(__dirname, '..', 'migrations');

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });

  const client = await pool.connect();
  try {
    // Prevent concurrent migration runs across multiple Render instances.
    await client.query('SELECT pg_advisory_lock($1)', [4242424242]);
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id          bigserial PRIMARY KEY,
        filename    text NOT NULL UNIQUE,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const appliedRes = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(appliedRes.rows.map(r => r.filename));

    const files = listMigrations(migrationsDir);
    for (const filename of files) {
      if (applied.has(filename)) continue;
      const full = path.join(migrationsDir, filename);
      const sql = fs.readFileSync(full, 'utf8');
      console.log(`[migrate] applying ${filename}`);
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    }

    await client.query('COMMIT');
    console.log('[migrate] done');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[migrate] failed:', e.message);
    process.exitCode = 1;
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [4242424242]); } catch { /* ignore */ }
    client.release();
    await pool.end();
  }
}

main();


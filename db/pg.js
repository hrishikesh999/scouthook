'use strict';

const { Pool } = require('pg');
const { qmarkToDollar } = require('./placeholder');

function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for Postgres mode');
  }
  return new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: Number(process.env.PGPOOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_MS || 30_000),
    connectionTimeoutMillis: Number(process.env.PGPOOL_CONN_TIMEOUT_MS || 10_000),
  });
}

const pool = createPool();

async function query(text, params) {
  return pool.query(text, params);
}

function prepare(sql) {
  const text = qmarkToDollar(sql);
  return {
    async get(...params) {
      const res = await query(text, params);
      return res.rows[0];
    },
    async all(...params) {
      const res = await query(text, params);
      return res.rows;
    },
    async run(...params) {
      const res = await query(text, params);
      // Compatibility shim for Better-SQLite3 callers
      const firstRow = res.rows && res.rows[0];
      const lastInsertRowid = firstRow && (firstRow.id ?? firstRow.inserted_id ?? null);
      return {
        changes: res.rowCount ?? 0,
        lastInsertRowid,
      };
    },
  };
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txDb = {
      prepare(sql) {
        const text = qmarkToDollar(sql);
        return {
          async get(...params) {
            const res = await client.query(text, params);
            return res.rows[0];
          },
          async all(...params) {
            const res = await client.query(text, params);
            return res.rows;
          },
          async run(...params) {
            const res = await client.query(text, params);
            const firstRow = res.rows && res.rows[0];
            const lastInsertRowid = firstRow && (firstRow.id ?? firstRow.inserted_id ?? null);
            return { changes: res.rowCount ?? 0, lastInsertRowid };
          },
        };
      },
      async exec(sql) {
        await client.query(sql);
      },
    };
    const out = await fn(txDb);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  kind: 'pg',
  pool,
  query,
  prepare,
  transaction,
};


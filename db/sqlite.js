'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'scouthook.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = {
  kind: 'sqlite',
  db,
  prepare(sql) {
    const stmt = db.prepare(sql);
    return {
      async get(...params) {
        return stmt.get(...params);
      },
      async all(...params) {
        return stmt.all(...params);
      },
      async run(...params) {
        const res = stmt.run(...params);
        return { changes: res.changes ?? 0, lastInsertRowid: res.lastInsertRowid ?? null };
      },
    };
  },
  async transaction(fn) {
    // Minimal-change shim: keep call sites async-friendly.
    // We do not rely on SQLite transactional semantics in production (Postgres is used there).
    return await fn({
      prepare: sql => module.exports.prepare(sql),
      exec: async sql => db.exec(sql),
    });
  },
  exec: async sql => db.exec(sql),
};


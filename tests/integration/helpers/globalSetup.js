'use strict';

// Jest globalSetup — runs once before all test files in a single Node.js process.
// Wakes up the Neon serverless compute so the first test file doesn't hit a cold
// start. Without this, the first DB query can take 3-10s and trigger test timeouts.

require('dotenv').config({ path: '.env.test', override: true });

const { Pool } = require('pg');

module.exports = async function globalSetup() {
  if (process.env.NODE_ENV !== 'test') return;

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });

  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }
  await pool.end();
  if (lastErr && !(await pool.query('SELECT 1').catch(() => null))) {
    throw new Error(`[globalSetup] Cannot connect to test DB: ${lastErr.message}`);
  }
};

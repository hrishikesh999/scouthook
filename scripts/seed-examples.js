#!/usr/bin/env node
'use strict';

/**
 * Seed the example_library table from db/seeds/example_library.json.
 *
 * Safe to re-run — skips rows whose source_url already exists in the table.
 * Rows with a placeholder source_url (containing "placeholder") are skipped.
 *
 * Usage:
 *   DATABASE_URL=<url> node scripts/seed-examples.js
 *   node scripts/seed-examples.js          (uses DATABASE_URL from process.env)
 */

const path = require('path');
const fs   = require('fs');
const { Pool } = require('pg');

const SEED_FILE = path.join(__dirname, '../db/seeds/example_library.json');

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  let rows;
  try {
    const raw = fs.readFileSync(SEED_FILE, 'utf8');
    rows = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read seed file: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    console.log('Seed file is empty or not an array. Nothing to insert.');
    await pool.end();
    return;
  }

  let inserted = 0;
  let skipped  = 0;

  for (const row of rows) {
    const { post_text, post_type, hook_archetype, niche, source_url } = row;

    if (!post_text || !post_text.trim()) {
      console.warn('Skipping row with empty post_text');
      skipped++;
      continue;
    }

    if (!source_url || source_url.includes('placeholder')) {
      console.warn('Skipping placeholder row');
      skipped++;
      continue;
    }

    try {
      const result = await pool.query(
        `INSERT INTO example_library (post_text, post_type, hook_archetype, niche, source_url, approved, approved_at)
         VALUES ($1, $2, $3, $4, $5, true, NOW())
         ON CONFLICT (source_url) DO NOTHING`,
        [post_text.trim(), post_type || null, hook_archetype || null, niche || null, source_url]
      );
      if (result.rowCount > 0) {
        inserted++;
        console.log(`Inserted: ${source_url}`);
      } else {
        skipped++;
        console.log(`Already exists, skipped: ${source_url}`);
      }
    } catch (err) {
      console.error(`Error inserting ${source_url}: ${err.message}`);
      skipped++;
    }
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) AS n FROM example_library WHERE approved = true AND retired = false`
  );
  const total = countResult.rows[0]?.n ?? 0;

  console.log(`\nDone. Inserted: ${inserted} | Skipped: ${skipped}`);
  console.log(`Total approved posts in library: ${total}`);
  if (parseInt(total, 10) < 40) {
    console.log(`\nLibrary has ${total}/40 posts. Injection will not activate until 40 approved posts are seeded.`);
  } else {
    console.log(`Library is active — injection will fire on all generations.`);
  }

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

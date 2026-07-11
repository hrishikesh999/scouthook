#!/usr/bin/env node
'use strict';

/**
 * scripts/purge-weak-vault.js
 *
 * Development utility: purge all auto-extracted and auto-generated vault ideas
 * to start fresh with higher quality extraction.
 *
 * Usage:
 *   node scripts/purge-weak-vault.js [tenant_id]
 *   node scripts/purge-weak-vault.js  # purges ALL auto_extracted globally
 *
 * This does NOT delete document-mined or manually-created vault ideas.
 */

require('dotenv').config();
const { db } = require('../db');

async function purgeWeakVault(tenantId = null) {
  try {
    let where = "source IN ('auto_extracted', 'idea_engine')";
    if (tenantId) where += ` AND tenant_id = '${tenantId}'`;

    const deleted = await db.prepare(`DELETE FROM vault_ideas WHERE ${where}`).run();
    console.log(`✓ Deleted ${deleted.changes} weak vault entries${tenantId ? ` for tenant ${tenantId}` : ' (all tenants)'}`);

    // Also purge idea_cards that referenced those facts
    const cardDeleted = await db.prepare(`
      DELETE FROM idea_cards
      WHERE tenant_id = ?
        AND provenance_ref LIKE 'vault_idea:%'
    `).run(tenantId || '%');
    console.log(`✓ Cleaned up ${cardDeleted.changes} stale idea cards`);

    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

const tenantId = process.argv[2];
purgeWeakVault(tenantId);

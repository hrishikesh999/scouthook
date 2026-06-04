'use strict';

const { db } = require('../db');

/**
 * Hard-delete workspaces whose purge_at timestamp has passed.
 * All content is removed via CASCADE DELETE on the workspaces FK.
 * Called on a daily cron from server.js.
 */
async function purgeExpiredWorkspaces() {
  try {
    const stale = await db.prepare(
      "SELECT id, name FROM workspaces WHERE purge_at < now() AND deleted_at IS NOT NULL"
    ).all();

    if (!stale.length) return;

    for (const ws of stale) {
      try {
        await db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id);
        console.log(`[workspacePurge] hard-deleted workspace ${ws.id} (${ws.name})`);
      } catch (err) {
        console.error(`[workspacePurge] failed to delete workspace ${ws.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[workspacePurge] purgeExpiredWorkspaces error:', err.message);
  }
}

module.exports = { purgeExpiredWorkspaces };

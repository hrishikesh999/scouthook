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

/**
 * Delete expired, unaccepted workspace invites older than 14 days past their expiry.
 * The 14-day buffer keeps recent expiries visible in the UI briefly after they lapse.
 * Called on a daily cron from server.js alongside purgeExpiredWorkspaces.
 */
async function purgeExpiredInvites() {
  try {
    const result = await db.prepare(`
      DELETE FROM workspace_invites
      WHERE accepted_at IS NULL AND expires_at < now() - interval '14 days'
    `).run();
    if (result.changes > 0) {
      console.log(`[workspacePurge] deleted ${result.changes} expired invite(s)`);
    }
  } catch (err) {
    console.error('[workspacePurge] purgeExpiredInvites error:', err.message);
  }
}

module.exports = { purgeExpiredWorkspaces, purgeExpiredInvites };

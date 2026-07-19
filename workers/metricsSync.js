'use strict';

/**
 * workers/metricsSync.js — nightly LinkedIn engagement sync (Authentic Client
 * Engine, Phase 4.1).
 *
 * services/linkedinMetrics.syncWorkspaceMetrics() has always been able to batch
 * -sync a workspace's published posts, but nothing ever called it on a schedule.
 * This worker walks every workspace with a valid LinkedIn connection and syncs
 * its recent posts, so the performance-insights layer (Phase 4.2) has fresh
 * reaction/comment counts to learn from.
 *
 * Politeness: LinkedIn rate-limits hard. syncWorkspaceMetrics already stops a
 * workspace early on a 429; we additionally stagger workspaces with a small gap
 * and only consider posts published in the last 30 days (engagement flatlines
 * after that, and it saves API quota).
 *
 * Wired into server.js on a daily interval, alongside the workspace-purge cron.
 */

const { db } = require('../db');
const { syncWorkspaceMetrics } = require('../services/linkedinMetrics');

const WORKSPACE_GAP_MS = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sync engagement metrics for every workspace that has at least one recent
 * published post with a LinkedIn id. Returns a summary for logging/tests.
 */
async function syncAllWorkspaceMetrics({ gapMs = WORKSPACE_GAP_MS } = {}) {
  let workspaces = [];
  try {
    // Only workspaces with a recent, published, LinkedIn-backed post are worth a
    // token fetch. syncWorkspaceMetrics itself re-checks the 30-day window per post.
    workspaces = await db.prepare(`
      SELECT DISTINCT tenant_id
      FROM   generated_posts
      WHERE  status = 'published'
        AND  linkedin_post_id IS NOT NULL
        AND  published_at > now() - interval '30 days'
    `).all();
  } catch (err) {
    console.error('[metricsSync] workspace query failed:', err.message);
    return { workspaces: 0, synced: 0, skipped: 0, errors: 0 };
  }

  let totals = { workspaces: 0, synced: 0, skipped: 0, errors: 0 };

  for (const ws of workspaces) {
    const workspaceId = ws.tenant_id;
    try {
      const r = await syncWorkspaceMetrics(workspaceId);
      totals.workspaces += 1;
      totals.synced  += r.synced  || 0;
      totals.skipped += r.skipped || 0;
      totals.errors  += r.errors  || 0;
    } catch (err) {
      totals.errors += 1;
      console.error(`[metricsSync] workspace ${workspaceId} failed:`, err.message);
    }
    if (gapMs) await sleep(gapMs);
  }

  console.log(`[metricsSync] done — workspaces=${totals.workspaces} synced=${totals.synced} skipped=${totals.skipped} errors=${totals.errors}`);
  return totals;
}

module.exports = { syncAllWorkspaceMetrics };

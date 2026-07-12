'use strict';

/**
 * services/ideaPrecompute.js — nightly idea card warm-up (Phase 2, task 12).
 *
 * Runs once per UTC day (from ~06:00 UTC) and calls getDailyCards() for every
 * active user, so the day's cards exist before the daily-ideas email cron and
 * the first dashboard load. getDailyCards() is idempotent per workspace per
 * day (cached in idea_cards keyed on served_on = CURRENT_DATE), so re-running
 * — or racing a user's own dashboard load — costs one SELECT, never a
 * duplicate set.
 *
 * "Active" = pipeline activity in the last 14 days, or idea emails enabled
 * (cadence set and not 'off' — NULL means the weekly default, which counts).
 * Warming for dormant users would burn Sonnet calls nobody reads.
 */

const { db, getSetting, setSetting } = require('../db');
const { getDailyCards } = require('./ideaEngine');

const LAST_RUN_KEY = 'idea_precompute_last_run';
const RUN_FROM_UTC_HOUR = 6;

async function findActiveUsers() {
  return db.prepare(`
    SELECT up.user_id,
           COALESCE(
             up.last_active_workspace_id,
             (SELECT w.id
              FROM   workspaces w
              JOIN   workspace_members wm ON wm.workspace_id = w.id
              WHERE  wm.user_id = up.user_id AND wm.role = 'owner' AND w.deleted_at IS NULL
              ORDER  BY w.created_at ASC LIMIT 1)
           ) AS workspace_id
    FROM   user_profiles up
    WHERE  up.email IS NOT NULL
      AND  COALESCE(up.idea_email_cadence, 'weekly') <> 'off'
      AND (
        EXISTS (SELECT 1 FROM platform_events pe
                WHERE pe.user_id = up.user_id AND pe.created_at > now() - INTERVAL '14 days')
        OR EXISTS (SELECT 1 FROM generated_posts gp
                WHERE gp.user_id = up.user_id AND gp.created_at > now() - INTERVAL '14 days')
      )
  `).all();
}

async function runIdeaPrecompute() {
  const users = await findActiveUsers();
  let warmed = 0, failed = 0;

  for (const u of users) {
    if (!u.workspace_id) continue;
    try {
      const { fresh } = await getDailyCards(u.user_id, u.workspace_id);
      if (fresh) warmed++;
    } catch (err) {
      failed++;
      console.warn(`[idea-precompute] failed for userId=${u.user_id} (non-fatal):`, err.message);
    }
  }

  console.log(`[idea-precompute] done: ${users.length} active users, ${warmed} warmed fresh, ${failed} failed`);
  return { total: users.length, warmed, failed };
}

/**
 * Cron tick — call every ~30 min from server.js. Fires at most once per UTC
 * day, no earlier than 06:00 UTC. Last-run date persists in platform_settings
 * so restarts don't re-run (getDailyCards would no-op anyway, but the fleet
 * scan itself isn't free).
 */
async function ideaPrecomputeTick() {
  try {
    const now = new Date();
    if (now.getUTCHours() < RUN_FROM_UTC_HOUR) return;
    const today = now.toISOString().slice(0, 10);
    if ((await getSetting(LAST_RUN_KEY)) === today) return;
    await setSetting(LAST_RUN_KEY, today);
    await runIdeaPrecompute();
  } catch (err) {
    console.warn('[idea-precompute] tick error (non-fatal):', err.message);
  }
}

module.exports = { runIdeaPrecompute, ideaPrecomputeTick };

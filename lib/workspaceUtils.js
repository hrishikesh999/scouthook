'use strict';

const { db } = require('../db');
const { getWorkspaceLimit } = require('./planFeatures');

// Lazy-require scheduler to avoid circular deps at startup — only used when BullMQ is live.
function getRemoveScheduledJob() {
  try { return require('../services/scheduler').removeScheduledJob; } catch { return null; }
}

/**
 * Put workspaces beyond the plan limit into a 30-day grace period.
 * Oldest workspaces (by created_at) are kept; newest excess ones enter grace.
 * Called after every plan downgrade.
 */
async function enforceWorkspaceLimitGrace(userId, plan, extraWorkspaces = 0) {
  const limit = getWorkspaceLimit(plan, extraWorkspaces);

  const owned = await db.prepare(`
    SELECT w.id, w.name FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ? AND wm.role = 'owner' AND w.deleted_at IS NULL
    ORDER BY w.created_at ASC
  `).all(userId);

  const toGrace = owned.slice(limit);
  if (!toGrace.length) return;

  const removeScheduledJob = getRemoveScheduledJob();

  for (const ws of toGrace) {
    // Cancel all pending scheduled posts for this workspace
    const pending = await db.prepare(
      "SELECT id FROM scheduled_posts WHERE tenant_id = ? AND status = 'pending'"
    ).all(ws.id);

    for (const post of pending) {
      if (removeScheduledJob) {
        await removeScheduledJob(post.id).catch(() => {});
      }
    }

    if (pending.length) {
      await db.prepare(
        "UPDATE scheduled_posts SET status = 'cancelled', error_message = 'workspace_grace_period', updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND status = 'pending'"
      ).run(ws.id);
    }

    await db.prepare(
      "UPDATE workspaces SET grace_expires_at = NOW() + INTERVAL '30 days' WHERE id = ? AND grace_expires_at IS NULL"
    ).run(ws.id);
  }

  // Send grace-period warning email (template: workspace-grace-period.html)
  try {
    const { sendEmailToUser } = require('../emails');
    const nameList = toGrace.map(w => `• ${w.name}`).join('\n');
    const purgeDate = new Date(Date.now() + 30 * 24 * 3600 * 1000)
      .toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    await sendEmailToUser(userId, 'workspace-grace-period', {
      workspace_names_list: nameList,
      grace_days: '30',
      purge_date: purgeDate,
      upgrade_url: `${process.env.APP_URL || 'https://app.scouthook.com'}/billing.html`,
    }, { dedupKey: `grace_${userId}_${toGrace[0].id}`, withinHours: 720 });
  } catch { /* non-fatal — template may not exist yet */ }
}

/**
 * Remove grace period from all workspaces the user owns.
 * Called after a plan upgrade or add-on workspace purchase.
 */
async function clearWorkspaceGracePeriods(userId) {
  await db.prepare(
    'UPDATE workspaces SET grace_expires_at = NULL WHERE id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ? AND role = ?)'
  ).run(userId, 'owner');
}

module.exports = { enforceWorkspaceLimitGrace, clearWorkspaceGracePeriods };

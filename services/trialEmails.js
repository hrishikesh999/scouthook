'use strict';

const { db } = require('../db');
const { sendEmailToUser } = require('../emails');

const APP_URL = () => process.env.APP_URL || 'https://app.scouthook.com';

// ---------------------------------------------------------------------------
// Settle window
// When multiple milestones fire in the same session (e.g. LinkedIn connect
// inside onboarding), the 20-min timer resets each time so only ONE evaluation
// runs after the user finishes. Uses an in-memory Map — non-persistent by
// design; the hourly cron catches anything lost on restart.
// ---------------------------------------------------------------------------
const pendingEvals = new Map(); // userId → setTimeout handle

function scheduleTrialEvaluation(userId, workspaceId) {
  if (pendingEvals.has(userId)) clearTimeout(pendingEvals.get(userId));
  const handle = setTimeout(() => {
    pendingEvals.delete(userId);
    evaluateAndSend(userId, workspaceId).catch(err =>
      console.warn('[trialEmails] settle-window eval error (non-fatal):', err.message)
    );
  }, 20 * 60 * 1000);
  pendingEvals.set(userId, handle);
}

// ---------------------------------------------------------------------------
// State resolution — always evaluates the user's primary (oldest) workspace.
// ---------------------------------------------------------------------------
async function getUserTrialState(userId) {
  const [sub, userProfile] = await Promise.all([
    db.prepare(
      'SELECT plan, status, trial_ends_at, paddle_subscription_id FROM user_subscriptions WHERE user_id = ?'
    ).get(userId),
    db.prepare(
      'SELECT onboarding_completed_at FROM user_profiles WHERE user_id = ?'
    ).get(userId),
  ]);

  // Resolve the primary (oldest non-deleted) workspace the user owns
  const primaryWs = await db.prepare(`
    SELECT w.id FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ? AND wm.role = 'owner' AND w.deleted_at IS NULL
    ORDER BY w.created_at ASC LIMIT 1
  `).get(userId);

  const workspaceId = primaryWs?.id;
  if (!workspaceId) return null;

  const [profile, linkedin, postRow, publishedRow] = await Promise.all([
    db.prepare(`
      SELECT p.content_themes,
             bvp.brand_industry, bvp.elevator_main_result
      FROM   profiles p
      LEFT JOIN brand_voice_profiles bvp ON bvp.profile_id = p.id
      WHERE  p.workspace_id = ? AND p.is_default = true
    `).get(workspaceId),
    db.prepare(`
      SELECT id FROM linkedin_connections
      WHERE workspace_id = ? AND account_type = 'personal' LIMIT 1
    `).get(workspaceId),
    db.prepare(
      'SELECT COUNT(*) AS cnt FROM generated_posts WHERE tenant_id = ?'
    ).get(workspaceId),
    db.prepare(
      "SELECT COUNT(*) AS cnt FROM generated_posts WHERE tenant_id = ? AND status = 'published'"
    ).get(workspaceId),
  ]);

  const isPaid = !!sub?.paddle_subscription_id || sub?.status === 'lifetime';
  const trialEndsAt = sub?.trial_ends_at ? new Date(sub.trial_ends_at) : null;
  const daysLeft = trialEndsAt
    ? Math.ceil((trialEndsAt.getTime() - Date.now()) / 86400000)
    : null;
  const isTrialActive = !isPaid && sub?.status === 'trialing' && daysLeft !== null && daysLeft > 0;

  let contentThemes = [];
  try { contentThemes = profile?.content_themes ? JSON.parse(profile.content_themes) : []; } catch { /* ignore */ }

  return {
    primaryWorkspaceId: workspaceId,
    isPaid,
    isTrialActive,
    daysLeft,
    onboarded:    !!userProfile?.onboarding_completed_at,
    linkedin:     !!linkedin,
    postsCount:   Number(postRow?.cnt ?? 0),
    published:    Number(publishedRow?.cnt ?? 0) > 0,
    industry:     profile?.brand_industry || null,
    contentTheme: contentThemes[0] || null,
  };
}

// ---------------------------------------------------------------------------
// Email history — which trial-* templates have already been sent.
// ---------------------------------------------------------------------------
async function getEmailHistory(userId) {
  const rows = await db.prepare(`
    SELECT DISTINCT template FROM email_log
    WHERE user_id = ? AND template LIKE 'trial-%'
      AND sent_at > now() - INTERVAL '8 days'
  `).all(userId);
  return new Set(rows.map(r => r.template));
}

async function anyEmailInLastNHours(userId, hours) {
  const h = Math.max(1, Math.floor(Number(hours)));
  // Only check trial-* emails — welcome/admin emails should not delay trial nudges.
  const row = await db.prepare(`
    SELECT id FROM email_log
    WHERE user_id = ? AND template LIKE 'trial-%'
      AND sent_at > now() - (? * INTERVAL '1 hour')
    LIMIT 1
  `).get(userId, h);
  return !!row;
}

// ---------------------------------------------------------------------------
// Decision tree — pure function, no side effects.
// Returns the template name to send next, or null if nothing should go out.
// ---------------------------------------------------------------------------
function getNextEmailTemplate(state, sent) {
  if (state.isPaid || !state.isTrialActive) return null;

  // Urgency — bypass the 24 h inter-email cooldown at the call site
  if (state.daysLeft <= 1 && !sent.has('trial-last-day')) return 'trial-last-day';
  // T-3 window belongs to the existing trial-expiry cron; don't compete
  if (state.daysLeft <= 3) return null;

  // All milestones complete → push upgrade once on day 4
  if (state.published) {
    if (state.daysLeft <= 4 && !sent.has('trial-convert-push')) return 'trial-convert-push';
    return null;
  }

  // Post generated but LinkedIn missing — user is physically blocked from publishing
  if (state.postsCount > 0 && !state.linkedin) {
    if (!sent.has('trial-need-linkedin-to-publish')) return 'trial-need-linkedin-to-publish';
    return null;
  }

  // Post generated + LinkedIn → one push to publish
  if (state.postsCount > 0 && !state.published) {
    if (!sent.has('trial-nudge-publish-1')) return 'trial-nudge-publish-1';
    return null;
  }

  // LinkedIn connected, no posts yet → one nudge to generate
  if (state.linkedin && state.postsCount === 0) {
    if (!sent.has('trial-nudge-generate-1')) return 'trial-nudge-generate-1';
    return null;
  }

  // Onboarded but no LinkedIn → one nudge
  if (state.onboarded && !state.linkedin) {
    if (!sent.has('trial-nudge-linkedin-1')) return 'trial-nudge-linkedin-1';
    return null;
  }

  // Not yet onboarded → one nudge
  if (!state.onboarded) {
    if (!sent.has('trial-nudge-onboard-1')) return 'trial-nudge-onboard-1';
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Template variable bundle
// ---------------------------------------------------------------------------
function buildVars(state, name) {
  const appUrl = APP_URL();
  return {
    name,
    app_url:       appUrl,
    upgrade_url:   `${appUrl}/billing.html`,
    generate_url:  `${appUrl}/generate.html`,
    settings_url:  `${appUrl}/settings.html`,
    linkedin_url:  `${appUrl}/api/linkedin/connect?from=settings`,
    days_left:         String(state.daysLeft ?? ''),
    posts_count:       String(state.postsCount),
    posts_count_label: state.postsCount === 1 ? '1 post' : `${state.postsCount} posts`,
    industry:          state.industry    || 'your industry',
    content_theme:     state.contentTheme || 'your niche',
  };
}

// ---------------------------------------------------------------------------
// Main entry point — called by both event hooks and the hourly cron.
//
// callerWorkspaceId: the workspace that triggered the event. When null (cron),
// the primary-workspace guard is skipped. When set (event hook), we bail if
// it doesn't match the primary workspace — prevents second-workspace events
// from triggering the onboarding sequence for an experienced user.
// ---------------------------------------------------------------------------
async function evaluateAndSend(userId, callerWorkspaceId) {
  try {
    const state = await getUserTrialState(userId);
    if (!state) return;

    // Secondary-workspace guard (event hooks only)
    if (callerWorkspaceId && state.primaryWorkspaceId !== callerWorkspaceId) return;

    if (state.isPaid || !state.isTrialActive) return;

    const [sent, userInfo] = await Promise.all([
      getEmailHistory(userId),
      db.prepare('SELECT email, display_name FROM user_profiles WHERE user_id = ?').get(userId),
    ]);

    if (!userInfo?.email) return;

    const template = getNextEmailTemplate(state, sent);
    if (!template) return;

    const name = (userInfo.display_name || '').split(' ')[0] || 'there';
    const isUrgency = template === 'trial-last-day';

    // Enforce 24 h inter-email cooldown for non-urgency emails
    if (!isUrgency && await anyEmailInLastNHours(userId, 24)) return;

    await sendEmailToUser(
      userId,
      template,
      buildVars(state, name),
      { dedupKey: `${template}:${userId}`, withinHours: 8 * 24 }
    );

    console.log(`[trialEmails] sent '${template}' userId=${userId} daysLeft=${state.daysLeft}`);
  } catch (err) {
    console.warn('[trialEmails] evaluateAndSend error (non-fatal):', err.message);
  }
}

// ---------------------------------------------------------------------------
// Hourly cron helper — called from server.js.
// Evaluates every active app-level trial user (no Paddle subscription yet).
// ---------------------------------------------------------------------------
async function runTrialEmailCron() {
  try {
    const users = await db.prepare(`
      SELECT up.user_id
      FROM user_profiles up
      JOIN user_subscriptions us ON us.user_id = up.user_id
      WHERE us.status = 'trialing'
        AND us.paddle_subscription_id IS NULL
        AND us.trial_ends_at > now()
        AND up.email IS NOT NULL
    `).all();

    for (const u of users) {
      // Pass null for callerWorkspaceId so the primary-workspace guard is skipped
      await evaluateAndSend(u.user_id, null).catch(err =>
        console.warn(`[trialEmails] cron error for userId=${u.user_id} (non-fatal):`, err.message)
      );
    }
  } catch (err) {
    console.warn('[trialEmails] cron query error (non-fatal):', err.message);
  }
}

module.exports = { scheduleTrialEvaluation, evaluateAndSend, runTrialEmailCron };

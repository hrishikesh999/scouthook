'use strict';

/**
 * services/trialEmails.js — the single spine for trial lifecycle email.
 *
 * One email per user per day, chosen by priority:
 *
 *   1. Urgency        — trial-last-day (T-1)
 *   2. Day-N sequence — the welcome/nurture story arc + the day-4 conversion ask
 *   3. Behavioural    — the stuck-user nudge ladder, as fallback only
 *
 * The 7-day calendar (day 0 = signup):
 *
 *   day 0  welcome                     (sent at verify, routes/email-auth.js)
 *   day 1  nurture-1                   why consistency beats ideas
 *   day 2  nurture-2                   the almost-quit story
 *   day 3  nurture-3                   perfection vs. compounding
 *   day 4  trial-convert-push          if they've published
 *          trial-expiry                otherwise (T-3 warning)
 *   day 5  nurture-4                   the profile leak
 *   day 6  trial-last-day              urgency
 *   day 8+ nurture-5                   post-trial, non-buyers only
 *
 * Nurture emails do NOT hard-code their call to action. Each one renders
 * {{cta_block}} from the user's actual state, so a story about publishing your
 * first post never asks someone with nine published posts to publish their
 * first. See buildCtaBlock().
 *
 * Day number comes from user_profiles.created_at, not from trial_ends_at —
 * an admin extending a trial (routes/admin.js) shifts the end date, and
 * deriving the day from it would rewind the sequence and resend emails.
 */

const { db } = require('../db');
const { sendEmailToUser } = require('../emails');
const { unsubscribeUrl } = require('./emailTokens');

const APP_URL = () => process.env.APP_URL || 'https://app.scouthook.com';

// Day-indexed story arc. Days absent from this map fall through to the
// behavioural ladder (day 0) or are owned by an urgency rule (day 6).
const SEQUENCE = { 1: 'nurture-1', 2: 'nurture-2', 3: 'nurture-3', 5: 'nurture-4' };

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
      `SELECT onboarding_completed_at, created_at, lifecycle_emails_opt_out_at
       FROM   user_profiles WHERE user_id = ?`
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
      SELECT content_themes FROM profiles
      WHERE  workspace_id = ? AND is_default = true
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

  // Whole days since signup. Day 0 is signup day.
  const signupAt = userProfile?.created_at ? new Date(userProfile.created_at) : null;
  const trialDay = signupAt
    ? Math.floor((Date.now() - signupAt.getTime()) / 86400000)
    : null;

  let contentThemes = [];
  try { contentThemes = profile?.content_themes ? JSON.parse(profile.content_themes) : []; } catch { /* ignore */ }

  return {
    primaryWorkspaceId: workspaceId,
    isPaid,
    isTrialActive,
    daysLeft,
    trialDay,
    trialEndsAt,
    optedOut:     !!userProfile?.lifecycle_emails_opt_out_at,
    onboarded:    !!userProfile?.onboarding_completed_at,
    linkedin:     !!linkedin,
    postsCount:   Number(postRow?.cnt ?? 0),
    published:    Number(publishedRow?.cnt ?? 0) > 0,
    contentTheme: contentThemes[0] || null,
  };
}

// ---------------------------------------------------------------------------
// Email history — which lifecycle templates have already been sent.
// Window covers the full trial plus the post-trial nurture slot.
// ---------------------------------------------------------------------------
async function getEmailHistory(userId) {
  const rows = await db.prepare(`
    SELECT DISTINCT template FROM email_log
    WHERE user_id = ? AND (template LIKE 'trial-%' OR template LIKE 'nurture-%')
      AND sent_at > now() - INTERVAL '30 days'
  `).all(userId);
  return new Set(rows.map(r => r.template));
}

async function anyEmailInLastNHours(userId, hours) {
  const h = Math.max(1, Math.floor(Number(hours)));
  // Only lifecycle email counts — transactional and welcome must not delay it.
  const row = await db.prepare(`
    SELECT id FROM email_log
    WHERE user_id = ? AND (template LIKE 'trial-%' OR template LIKE 'nurture-%')
      AND sent_at > now() - (? * INTERVAL '1 hour')
    LIMIT 1
  `).get(userId, h);
  return !!row;
}

// ---------------------------------------------------------------------------
// Behavioural ladder — the original stuck-user nudges, now a fallback that
// only runs on days the story arc has nothing scheduled.
// ---------------------------------------------------------------------------
function getBehaviouralNudge(state, sent) {
  // Post generated but LinkedIn missing — physically blocked from publishing
  if (state.postsCount > 0 && !state.linkedin) {
    return sent.has('trial-need-linkedin-to-publish') ? null : 'trial-need-linkedin-to-publish';
  }
  if (state.postsCount > 0 && !state.published) {
    return sent.has('trial-nudge-publish-1') ? null : 'trial-nudge-publish-1';
  }
  if (state.linkedin && state.postsCount === 0) {
    return sent.has('trial-nudge-generate-1') ? null : 'trial-nudge-generate-1';
  }
  if (state.onboarded && !state.linkedin) {
    return sent.has('trial-nudge-linkedin-1') ? null : 'trial-nudge-linkedin-1';
  }
  if (!state.onboarded) {
    return sent.has('trial-nudge-onboard-1') ? null : 'trial-nudge-onboard-1';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Decision tree — pure function, no side effects.
// Returns the template name to send next, or null if nothing should go out.
// ---------------------------------------------------------------------------
function getNextEmailTemplate(state, sent) {
  if (state.optedOut) return null;
  if (state.isPaid || !state.isTrialActive) return null;

  // 1. Urgency — bypasses the 24h cooldown at the call site
  if (state.daysLeft <= 1) {
    return sent.has('trial-last-day') ? null : 'trial-last-day';
  }

  // 2. Day-N sequence
  const day = state.trialDay;
  if (day !== null) {
    // Day 4 is the conversion slot. Activated users get the upgrade push;
    // everyone else gets the T-3 expiry warning.
    if (day === 4) {
      const template = state.published ? 'trial-convert-push' : 'trial-expiry';
      if (!sent.has(template)) return template;
      return null; // conversion day stays conversion-only
    }
    const scheduled = SEQUENCE[day];
    if (scheduled && !sent.has(scheduled)) return scheduled;
  }

  // 3. Behavioural fallback — only when the arc had nothing for today
  return getBehaviouralNudge(state, sent);
}

// ---------------------------------------------------------------------------
// State-aware call to action. Nurture templates render this instead of
// hard-coding "publish your first post".
// ---------------------------------------------------------------------------
function link(href, label) {
  return `<p style="margin:0 0 24px;"><a href="${href}" style="color:#0F766E;text-decoration:underline;">${label} &rarr;</a></p>`;
}

function buildCtaBlock(state) {
  const appUrl = APP_URL();
  if (!state.isTrialActive && !state.isPaid) {
    return link(`${appUrl}/billing.html`, 'Pick your plan and keep publishing');
  }
  if (!state.onboarded) {
    return link(`${appUrl}/onboarding.html`, 'Finish your voice profile (about 2 minutes)');
  }
  if (!state.linkedin) {
    return link(`${appUrl}/api/linkedin/connect?from=settings`, 'Connect LinkedIn so you can publish');
  }
  if (state.postsCount === 0) {
    return link(`${appUrl}/generate.html`, 'Log in to ScoutHook and generate your first post');
  }
  if (!state.published) {
    return link(`${appUrl}/generate.html`, 'Log in to ScoutHook and publish your first post');
  }
  return link(`${appUrl}/generate.html`, 'Log in to ScoutHook and create your next post');
}

// ---------------------------------------------------------------------------
// Template variable bundle
// ---------------------------------------------------------------------------
function buildVars(state, name, userId) {
  const appUrl = APP_URL();
  const trialEndDate = state.trialEndsAt
    ? state.trialEndsAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
    : '';
  return {
    name,
    display_name:  name,
    app_url:       appUrl,
    upgrade_url:   `${appUrl}/billing.html`,
    generate_url:  `${appUrl}/generate.html`,
    settings_url:  `${appUrl}/settings.html`,
    linkedin_url:  `${appUrl}/api/linkedin/connect?from=settings`,
    prefs_url:     unsubscribeUrl(userId),
    cta_block:     buildCtaBlock(state),
    days_left:         String(state.daysLeft ?? ''),
    trial_end_date:    trialEndDate,
    posts_count:       String(state.postsCount),
    posts_count_label: state.postsCount === 1 ? '1 post' : `${state.postsCount} posts`,
    industry:          'your industry',
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

    if (state.optedOut) return;
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

    // One lifecycle email per day — urgency is the only thing that jumps it
    if (!isUrgency && await anyEmailInLastNHours(userId, 20)) return;

    await sendEmailToUser(
      userId,
      template,
      buildVars(state, name, userId),
      { dedupKey: `${template}:${userId}`, withinHours: 30 * 24 }
    );

    console.log(`[trialEmails] sent '${template}' userId=${userId} day=${state.trialDay} daysLeft=${state.daysLeft}`);
  } catch (err) {
    console.warn('[trialEmails] evaluateAndSend error (non-fatal):', err.message);
  }
}

// ---------------------------------------------------------------------------
// Post-trial nurture — nurture-5 goes to trial users who never bought, one day
// after their trial lapses. This is the only lifecycle email sent outside an
// active trial, so it lives in its own pass rather than the day-N arc.
// ---------------------------------------------------------------------------
async function sendPostTrialNurture() {
  try {
    const users = await db.prepare(`
      SELECT up.user_id
      FROM   user_profiles up
      JOIN   user_subscriptions us ON us.user_id = up.user_id
      WHERE  us.paddle_subscription_id IS NULL
        AND  us.status <> 'lifetime'
        AND  us.trial_ends_at BETWEEN now() - INTERVAL '2 days' AND now()
        AND  up.email IS NOT NULL
        AND  up.lifecycle_emails_opt_out_at IS NULL
    `).all();

    for (const u of users) {
      try {
        const state = await getUserTrialState(u.user_id);
        if (!state || state.isPaid) continue;

        const info = await db.prepare(
          'SELECT display_name FROM user_profiles WHERE user_id = ?'
        ).get(u.user_id);
        const name = (info?.display_name || '').split(' ')[0] || 'there';

        await sendEmailToUser(
          u.user_id,
          'nurture-5',
          buildVars(state, name, u.user_id),
          { dedupKey: `nurture-5:${u.user_id}`, withinHours: 365 * 24 }
        );
      } catch (err) {
        console.warn(`[trialEmails] post-trial nurture failed for ${u.user_id} (non-fatal):`, err.message);
      }
    }
  } catch (err) {
    console.warn('[trialEmails] post-trial nurture query error (non-fatal):', err.message);
  }
}

// ---------------------------------------------------------------------------
// Hourly cron helper — called from server.js.
// Evaluates every active app-level trial user (no Paddle subscription yet),
// then runs the post-trial pass for lapsed non-buyers.
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
        AND up.lifecycle_emails_opt_out_at IS NULL
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

  await sendPostTrialNurture();
}

module.exports = {
  scheduleTrialEvaluation,
  evaluateAndSend,
  runTrialEmailCron,
  sendPostTrialNurture,
  getNextEmailTemplate,
  buildCtaBlock,
  buildVars,
};

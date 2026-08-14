'use strict';

/**
 * services/postLifecycleEmails.js — replaces trialEmails.js.
 *
 * The 7-day trial's day-clock is gone, so the lifecycle sequence is now
 * triggered by post-count milestones and behavioral state instead of days
 * since signup:
 *
 *   signup            welcome                     (sent at verify, routes/email-auth.js)
 *   behavioral ladder onboard/linkedin/generate/publish nudges — unchanged
 *                      from the old trial system, just re-gated on
 *                      "still free tier, cap not reached" instead of
 *                      "trial active"
 *   2nd free post      free-post-remaining         one free post left
 *   3rd free post       limit-reached               cap hit (same template
 *                      (cap hit)                    Pro users see for monthly quota)
 *   +3 days after cap  free-cap-followup           still hasn't upgraded
 *
 * Milestone emails (free-post-remaining / limit-reached) fire immediately,
 * right after the generation that crosses the threshold — evaluateMilestoneEmail()
 * is called directly from the generation routes, not debounced.
 *
 * The behavioral ladder still uses the 20-minute settle-window debounce
 * (schedulePostLifecycleEvaluation) so multiple events in one session only
 * evaluate once.
 *
 * The 3-day cap follow-up is the only remaining time-based check ("did
 * nothing" can't be event-triggered) — runs on a lightweight daily cron
 * instead of the old hourly full-population scan.
 */

const { db } = require('../db');
const { sendEmailToUser } = require('../emails');
const { unsubscribeUrl } = require('./emailTokens');

const APP_URL = () => process.env.APP_URL || 'https://app.scouthook.com';

// ---------------------------------------------------------------------------
// Settle window — same debounce pattern as the old trial system.
// ---------------------------------------------------------------------------
const pendingEvals = new Map(); // userId → setTimeout handle

function schedulePostLifecycleEvaluation(userId, workspaceId) {
  if (pendingEvals.has(userId)) clearTimeout(pendingEvals.get(userId));
  const handle = setTimeout(() => {
    pendingEvals.delete(userId);
    evaluateAndSend(userId, workspaceId).catch(err =>
      console.warn('[postLifecycleEmails] settle-window eval error (non-fatal):', err.message)
    );
  }, 20 * 60 * 1000);
  pendingEvals.set(userId, handle);
}

// ---------------------------------------------------------------------------
// State resolution — always evaluates the user's primary (oldest) workspace.
// ---------------------------------------------------------------------------
async function getUserFreeTierState(userId) {
  const [sub, userProfile] = await Promise.all([
    db.prepare(
      `SELECT plan, status, paddle_subscription_id, free_posts_limit, free_tier_started_at
       FROM user_subscriptions WHERE user_id = ?`
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

  const [profile, linkedin, postRow, publishedRow, freeCountRow] = await Promise.all([
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
    db.prepare(`
      SELECT COUNT(*) AS cnt, MAX(created_at) AS last_at
      FROM generated_posts
      WHERE user_id = ? AND passed_gate = 1
        AND created_at >= COALESCE(?, '-infinity'::timestamptz)
    `).get(userId, sub?.free_tier_started_at ?? null),
  ]);

  const isPaid = !!sub?.paddle_subscription_id || sub?.status === 'lifetime';
  const freePostsLimit = sub?.free_posts_limit ?? 3;
  const freePostsUsed  = Number(freeCountRow?.cnt ?? 0);
  const freeCapReached = !isPaid && freePostsUsed >= freePostsLimit;
  const capHitAt = freeCountRow?.last_at ? new Date(freeCountRow.last_at) : null;

  let contentThemes = [];
  try { contentThemes = profile?.content_themes ? JSON.parse(profile.content_themes) : []; } catch { /* ignore */ }

  return {
    primaryWorkspaceId: workspaceId,
    isPaid,
    freePostsLimit,
    freePostsUsed,
    freeCapReached,
    capHitAt,
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
// ---------------------------------------------------------------------------
async function getEmailHistory(userId) {
  const rows = await db.prepare(`
    SELECT DISTINCT template FROM email_log
    WHERE user_id = ? AND (
      template LIKE 'trial-nudge-%' OR template = 'trial-need-linkedin-to-publish'
      OR template = 'free-post-remaining' OR template = 'limit-reached' OR template = 'free-cap-followup'
    )
    AND sent_at > now() - INTERVAL '365 days'
  `).all(userId);
  return new Set(rows.map(r => r.template));
}

async function anyEmailInLastNHours(userId, hours) {
  const h = Math.max(1, Math.floor(Number(hours)));
  const row = await db.prepare(`
    SELECT id FROM email_log
    WHERE user_id = ? AND (template LIKE 'trial-nudge-%' OR template = 'trial-need-linkedin-to-publish')
      AND sent_at > now() - (? * INTERVAL '1 hour')
    LIMIT 1
  `).get(userId, h);
  return !!row;
}

// ---------------------------------------------------------------------------
// Behavioural ladder — unchanged content/logic from the old trial system,
// just re-triggered off "still free tier, cap not reached" instead of
// "trial active".
// ---------------------------------------------------------------------------
function getBehaviouralNudge(state, sent) {
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
// State-aware call to action — unchanged from the old trial system.
// ---------------------------------------------------------------------------
function link(href, label) {
  return `<p style="margin:0 0 24px;"><a href="${href}" style="color:#0F766E;text-decoration:underline;">${label} &rarr;</a></p>`;
}

function buildCtaBlock(state) {
  const appUrl = APP_URL();
  if (state.freeCapReached) {
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
    free_posts_used:      String(state.freePostsUsed),
    free_posts_limit:     String(state.freePostsLimit),
    free_posts_remaining: String(Math.max(0, state.freePostsLimit - state.freePostsUsed)),
    posts_count:       String(state.postsCount),
    posts_count_label: state.postsCount === 1 ? '1 post' : `${state.postsCount} posts`,
    industry:          'your industry',
    content_theme:     state.contentTheme || 'your niche',
  };
}

async function getFirstName(userId) {
  const info = await db.prepare('SELECT display_name FROM user_profiles WHERE user_id = ?').get(userId);
  return (info?.display_name || '').split(' ')[0] || 'there';
}

// ---------------------------------------------------------------------------
// evaluateMilestoneEmail — call directly (not debounced) right after a
// successful free-tier generation, so the "1 left" / "cap reached" emails
// fire immediately rather than waiting for the settle window.
// ---------------------------------------------------------------------------
async function evaluateMilestoneEmail(userId) {
  try {
    const state = await getUserFreeTierState(userId);
    if (!state || state.isPaid || state.optedOut) return;

    const remaining = state.freePostsLimit - state.freePostsUsed;
    const name = await getFirstName(userId);

    if (remaining === 1) {
      await sendEmailToUser(
        userId, 'free-post-remaining', buildVars(state, name, userId),
        { dedupKey: `free-post-remaining:${userId}`, withinHours: 365 * 24 }
      );
    } else if (remaining <= 0) {
      await sendEmailToUser(
        userId, 'free-cap-reached', buildVars(state, name, userId),
        { dedupKey: `free-cap-reached:${userId}`, withinHours: 365 * 24 }
      );
    }
  } catch (err) {
    console.warn('[postLifecycleEmails] evaluateMilestoneEmail error (non-fatal):', err.message);
  }
}

// ---------------------------------------------------------------------------
// evaluateAndSend — behavioral ladder only (milestones are handled above).
// Called by both event hooks (schedulePostLifecycleEvaluation) and other
// state-change hooks (e.g. onboarding complete, LinkedIn connect, publish).
// ---------------------------------------------------------------------------
async function evaluateAndSend(userId, callerWorkspaceId) {
  try {
    const state = await getUserFreeTierState(userId);
    if (!state) return;

    if (callerWorkspaceId && state.primaryWorkspaceId !== callerWorkspaceId) return;
    if (state.optedOut) return;
    if (state.isPaid || state.freeCapReached) return;

    const [sent, userInfo] = await Promise.all([
      getEmailHistory(userId),
      db.prepare('SELECT email, display_name FROM user_profiles WHERE user_id = ?').get(userId),
    ]);
    if (!userInfo?.email) return;

    const template = getBehaviouralNudge(state, sent);
    if (!template) return;

    if (await anyEmailInLastNHours(userId, 20)) return;

    const name = (userInfo.display_name || '').split(' ')[0] || 'there';
    await sendEmailToUser(
      userId, template, buildVars(state, name, userId),
      { dedupKey: `${template}:${userId}`, withinHours: 30 * 24 }
    );

    console.log(`[postLifecycleEmails] sent '${template}' userId=${userId}`);
  } catch (err) {
    console.warn('[postLifecycleEmails] evaluateAndSend error (non-fatal):', err.message);
  }
}

// ---------------------------------------------------------------------------
// Free-cap follow-up — one email, 3 days after a user hits their free-post
// cap, if they still haven't upgraded. Only remaining time-based check.
// ---------------------------------------------------------------------------
async function runFreeCapFollowupCron() {
  try {
    const candidates = await db.prepare(`
      SELECT up.user_id
      FROM   user_profiles up
      JOIN   user_subscriptions us ON us.user_id = up.user_id
      WHERE  us.paddle_subscription_id IS NULL
        AND  us.status <> 'lifetime'
        AND  COALESCE(us.plan, 'free') NOT IN ('solo', 'pro')
        AND  up.email IS NOT NULL
        AND  up.lifecycle_emails_opt_out_at IS NULL
    `).all();

    for (const u of candidates) {
      try {
        const state = await getUserFreeTierState(u.user_id);
        if (!state || state.isPaid || !state.freeCapReached || !state.capHitAt) continue;

        const daysSinceCap = (Date.now() - state.capHitAt.getTime()) / 86400000;
        if (daysSinceCap < 3) continue;

        const name = await getFirstName(u.user_id);
        await sendEmailToUser(
          u.user_id, 'free-cap-followup', buildVars(state, name, u.user_id),
          { dedupKey: `free-cap-followup:${u.user_id}`, withinHours: 365 * 24 }
        );
      } catch (err) {
        console.warn(`[postLifecycleEmails] cap follow-up failed for ${u.user_id} (non-fatal):`, err.message);
      }
    }
  } catch (err) {
    console.warn('[postLifecycleEmails] cap follow-up query error (non-fatal):', err.message);
  }
}

module.exports = {
  schedulePostLifecycleEvaluation,
  evaluateAndSend,
  evaluateMilestoneEmail,
  runFreeCapFollowupCron,
  getBehaviouralNudge,
  buildCtaBlock,
  buildVars,
};

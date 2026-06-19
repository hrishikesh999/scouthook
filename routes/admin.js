'use strict';

const express = require('express');
const router  = express.Router();
const { getSetting, setSetting, getAllSettings, db } = require('../db');
const { pool } = require('../db/pg');
const { getPaddle, upsertSubscription, getUserPlan } = require('../services/subscription');
const mailerlite = require('../services/mailerlite');
const { getUserEmailInfo } = require('../emails');

if (!process.env.ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD environment variable is required.');
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function requireAdminPassword(req, res, next) {
  const provided = req.headers['x-admin-password'] || req.body?.admin_password;
  if (provided !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

// ---------------------------------------------------------------------------
// GET /admin/settings
// ---------------------------------------------------------------------------
router.get('/settings', requireAdminPassword, (req, res) => {
  const SENSITIVE_KEYS = [
    'anthropic_api_key',
    'linkedin_client_secret',
    'token_encryption_key',
  ];

  (async () => {
    const rows = await getAllSettings();
    const settings = rows.map(row => ({
      key:    row.key,
      value:  SENSITIVE_KEYS.includes(row.key) && row.value
                ? row.value.slice(0, 6) + '…' + row.value.slice(-4)
                : row.value,
      is_set: !!row.value,
    }));
    return res.json({ ok: true, settings });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// POST /admin/settings
// ---------------------------------------------------------------------------
router.post('/settings', requireAdminPassword, (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ ok: false, error: 'settings object required' });
  }

  const ALLOWED_KEYS = [
    'anthropic_api_key',
    'linkedin_client_id',
    'linkedin_client_secret',
    'linkedin_redirect_uri',
    'token_encryption_key',
    'redis_url',
    'scheduling_enabled',
    'placid_api_key',
    'placid_template_id',
  ];

  (async () => {
    const updated = [];
    for (const [key, value] of Object.entries(settings)) {
      if (!ALLOWED_KEYS.includes(key)) continue;
      await setSetting(key, value);
      updated.push(key);
    }
    return res.json({ ok: true, updated });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// GET /admin/diagnostics
// Workspace-aware: shows users, their workspaces, subscription state, counts.
// ---------------------------------------------------------------------------
router.get('/diagnostics', requireAdminPassword, (req, res) => {
  (async () => {
    const users = await db.prepare(`
      SELECT
        up.user_id,
        up.email,
        up.display_name,
        up.created_at           AS profile_created_at,
        us.plan,
        us.status,
        us.trial_ends_at,
        us.current_period_end,
        us.paddle_subscription_id,
        COUNT(DISTINCT wm.workspace_id) AS workspace_count,
        (
          SELECT COUNT(*) FROM generated_posts gp
          JOIN workspace_members wm2 ON wm2.workspace_id = gp.tenant_id
          WHERE wm2.user_id = up.user_id
        ) AS post_count,
        (
          SELECT COUNT(*) FROM vault_documents vd
          JOIN workspace_members wm3 ON wm3.workspace_id = vd.tenant_id
          WHERE wm3.user_id = up.user_id
        ) AS vault_count
      FROM user_profiles up
      LEFT JOIN user_subscriptions us ON us.user_id = up.user_id
      LEFT JOIN workspace_members wm ON wm.user_id = up.user_id
      GROUP BY up.user_id, up.email, up.display_name, up.created_at,
               us.plan, us.status, us.trial_ends_at,
               us.current_period_end, us.paddle_subscription_id
      ORDER BY up.created_at DESC
      LIMIT 100
    `).all();

    for (const row of users) {
      row.workspaces = await db.prepare(`
        SELECT w.id, w.name, w.deleted_at, w.grace_expires_at,
               COUNT(wm.id) AS member_count
        FROM workspaces w
        JOIN workspace_members wm ON wm.workspace_id = w.id
        WHERE wm.user_id = ? AND wm.role = 'owner'
        GROUP BY w.id
        ORDER BY w.created_at
      `).all(row.user_id);
    }

    return res.json({ ok: true, users });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// GET /admin/workspaces/:workspaceId
// Deep-dive on a single workspace (support escalations).
// ---------------------------------------------------------------------------
router.get('/workspaces/:workspaceId', requireAdminPassword, (req, res) => {
  (async () => {
    const { workspaceId } = req.params;
    const ws = await db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    if (!ws) return res.status(404).json({ ok: false, error: 'workspace_not_found' });

    const [members, profiles, connections, postRow] = await Promise.all([
      db.prepare(`
        SELECT wm.user_id, wm.role, up.email, up.display_name, us.plan, us.status
        FROM workspace_members wm
        JOIN user_profiles up ON up.user_id = wm.user_id
        LEFT JOIN user_subscriptions us ON us.user_id = wm.user_id
        WHERE wm.workspace_id = ?
      `).all(workspaceId),
      db.prepare(`
        SELECT id, display_name, is_default,
               onboarding_complete, voice_profile_completion_pct
        FROM profiles WHERE workspace_id = ?
      `).all(workspaceId),
      db.prepare(`
        SELECT id, account_type, display_name, expires_at, is_default
        FROM linkedin_connections WHERE workspace_id = ?
      `).all(workspaceId),
      db.prepare(
        'SELECT COUNT(*) AS cnt FROM generated_posts WHERE tenant_id = ?'
      ).get(workspaceId),
    ]);

    return res.json({
      ok: true,
      workspace: ws,
      members,
      profiles,
      connections,
      post_count: postRow.cnt,
    });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// POST /admin/workspaces/:workspaceId/clear-grace
// Admin override: restore a workspace from grace period.
// ---------------------------------------------------------------------------
router.post('/workspaces/:workspaceId/clear-grace', requireAdminPassword, (req, res) => {
  (async () => {
    const { workspaceId } = req.params;
    await db.prepare(
      'UPDATE workspaces SET grace_expires_at = NULL WHERE id = ?'
    ).run(workspaceId);
    return res.json({ ok: true });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// POST /admin/workspaces/:workspaceId/restore
// Undo a soft-delete — clears deleted_at and purge_at so the workspace reappears.
// Use this when a workspace was accidentally deleted and needs to be recovered.
// ---------------------------------------------------------------------------
router.post('/workspaces/:workspaceId/restore', requireAdminPassword, (req, res) => {
  (async () => {
    const { workspaceId } = req.params;
    const ws = await db.prepare('SELECT id, deleted_at FROM workspaces WHERE id = ?').get(workspaceId);
    if (!ws) return res.status(404).json({ ok: false, error: 'workspace_not_found' });
    if (!ws.deleted_at) return res.json({ ok: true, note: 'workspace was not deleted' });
    await db.prepare(
      "UPDATE workspaces SET deleted_at = NULL, purge_at = NULL WHERE id = ?"
    ).run(workspaceId);
    return res.json({ ok: true, restored: workspaceId });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// POST /admin/sync-subscription
// Force-syncs a user's subscription by email, then enforces workspace limits.
// Body: { admin_password, email }
// ---------------------------------------------------------------------------
router.post('/sync-subscription', requireAdminPassword, (req, res) => {
  (async () => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: 'email is required' });

    const proPriceIds = [
      process.env.PADDLE_PRICE_ID_PRO,
      process.env.PADDLE_PRICE_ID_YEARLY,
    ].filter(Boolean);

    // Resolve user_id — check both direct email and auth_providers for email-auth users
    const profile = await db.prepare(`
      SELECT up.user_id FROM user_profiles up
      WHERE up.email = ?
      UNION
      SELECT up.user_id FROM user_profiles up
      JOIN auth_providers ap ON ap.user_id = up.user_id
      WHERE ap.provider = 'email' AND ap.provider_id = ?
      LIMIT 1
    `).get(email, email);
    if (!profile) return res.status(404).json({ ok: false, error: 'user not found' });
    const userId = profile.user_id;

    const paddle = getPaddle();
    const customerList = await paddle.customers.list({ email: [email] });
    const customers = customerList?.data ?? [];

    let subscription = null;
    for (const customer of customers) {
      const subList = await paddle.subscriptions.list({ customerId: [customer.id] });
      const subs = subList?.data ?? [];
      const best = subs.find(s => ['active', 'trialing'].includes(s.status))
        ?? subs.find(s => s.status !== 'canceled')
        ?? subs[0]
        ?? null;
      if (best) { subscription = best; break; }
    }

    if (!subscription) {
      return res.status(404).json({ ok: false, error: 'no_paddle_subscription_found' });
    }

    const priceId = subscription.items?.[0]?.price?.id ?? null;
    const plan    = !priceId ? 'pro' : (proPriceIds.includes(priceId) ? 'pro' : 'free');

    await upsertSubscription({
      userId,
      paddleCustomerId:     subscription.customerId,
      paddleSubscriptionId: subscription.id,
      plan,
      status:               subscription.status,
      currentPeriodEnd:     subscription.currentBillingPeriod?.endsAt
                              ? new Date(subscription.currentBillingPeriod.endsAt)
                              : null,
      canceledAt:           subscription.canceledAt ? new Date(subscription.canceledAt) : null,
      priceId,
    });

    // Enforce workspace limits after sync (Trap 1 / 8)
    try {
      const { enforceWorkspaceLimitGrace } = require('../lib/workspaceUtils');
      const sub = await db.prepare(
        'SELECT plan, extra_workspaces FROM user_subscriptions WHERE user_id = ?'
      ).get(userId);
      await enforceWorkspaceLimitGrace(userId, sub.plan, sub.extra_workspaces ?? 0);
    } catch (e) {
      console.warn('[admin] enforceWorkspaceLimitGrace failed:', e.message);
    }

    // Sync MailerLite
    getUserEmailInfo(userId).then(user => {
      if (!user) return;
      if (['solo', 'pro'].includes(plan) && ['active', 'trialing'].includes(subscription.status)) {
        mailerlite.upgradeSubscriberToPaid(user.email, user.name).catch(() => {});
      } else if (['canceled', 'past_due', 'paused'].includes(subscription.status)) {
        mailerlite.downgradeSubscriberToFree(user.email, user.name).catch(() => {});
      }
    }).catch(() => {});

    console.log(`[admin] force-synced subscription for ${email}: plan=${plan} status=${subscription.status}`);
    return res.json({ ok: true, email, userId, plan, status: subscription.status, subscriptionId: subscription.id });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// POST /admin/users/:userId/set-workspace
// Immediately switch a user's active workspace: updates their live sessions
// AND persists last_active_workspace_id so future logins also land correctly.
// Body: { admin_password, workspaceId }
// ---------------------------------------------------------------------------
router.post('/users/:userId/set-workspace', requireAdminPassword, (req, res) => {
  (async () => {
    const { userId } = req.params;
    const { workspaceId } = req.body || {};
    if (!workspaceId) return res.status(400).json({ ok: false, error: 'workspaceId required' });

    // Validate workspace exists and user is a member
    const member = await db.prepare(
      'SELECT wm.workspace_id FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE wm.user_id = ? AND wm.workspace_id = ? AND w.deleted_at IS NULL'
    ).get(userId, workspaceId);
    if (!member) return res.status(404).json({ ok: false, error: 'user is not a member of that workspace (or workspace is deleted)' });

    // Persist preference so future logins land here too (non-fatal if migration 038 not applied)
    try {
      await db.prepare(
        'UPDATE user_profiles SET last_active_workspace_id = ? WHERE user_id = ?'
      ).run(workspaceId, userId);
    } catch (e) {
      console.warn('[admin/set-workspace] last_active_workspace_id update skipped:', e.message);
    }

    // Patch all live sessions for this user — uses pg JSONB ops directly
    // (the db wrapper's qmarkToDollar would mangle the jsonb -> operator)
    const result = await pool.query(
      `UPDATE session
       SET sess = jsonb_set(sess::jsonb, '{passport,user,tenant_id}', to_jsonb($1::text), true)
       WHERE sess::jsonb -> 'passport' -> 'user' ->> 'user_id' = $2
         AND expire > now()`,
      [workspaceId, userId]
    );

    return res.json({ ok: true, sessions_updated: result.rowCount });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// GET /admin/users/:userId/workspaces
// List all workspaces for a user with post counts — used to diagnose blank-post issues.
// ---------------------------------------------------------------------------
router.get('/users/:userId/workspaces', requireAdminPassword, (req, res) => {
  (async () => {
    const { userId } = req.params;
    const up = await db.prepare(
      'SELECT user_id FROM user_profiles WHERE user_id = ?'
    ).get(userId);
    if (!up) return res.status(404).json({ ok: false, error: 'user not found' });

    // last_active_workspace_id requires migration 038 — degrade gracefully if missing
    let lastActiveWorkspaceId = null;
    try {
      const upEx = await db.prepare(
        'SELECT last_active_workspace_id FROM user_profiles WHERE user_id = ?'
      ).get(userId);
      lastActiveWorkspaceId = upEx?.last_active_workspace_id ?? null;
    } catch { /* column not yet added */ }

    const workspaces = await db.prepare(`
      SELECT w.id, w.name, w.deleted_at, wm.role, wm.created_at AS joined_at,
             (SELECT COUNT(*) FROM generated_posts WHERE tenant_id = w.id) AS post_count,
             (SELECT COUNT(*) FROM scheduled_posts WHERE tenant_id = w.id AND user_id = ?) AS scheduled_count,
             (SELECT COUNT(*) FROM linkedin_connections WHERE workspace_id = w.id) AS linkedin_connections
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ?
      ORDER BY post_count DESC, wm.created_at ASC
    `).all(userId, userId);

    return res.json({ ok: true, last_active_workspace_id: lastActiveWorkspaceId, workspaces });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

module.exports = router;

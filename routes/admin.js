'use strict';

const express = require('express');
const router  = express.Router();
const { getSetting, setSetting, getAllSettings, db } = require('../db');
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
      GROUP BY up.user_id, us.plan, us.status, us.trial_ends_at,
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
        SELECT id, profile_type, display_name, is_default,
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

module.exports = router;

'use strict';

const express = require('express');
const router = express.Router();
const { getSetting, setSetting, getAllSettings, db } = require('../db');
const { getPaddle, upsertSubscription } = require('../services/subscription');
const mailerlite = require('../services/mailerlite');
const { getUserEmailInfo } = require('../emails');

if (!process.env.ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD environment variable is required.');
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Simple password check middleware for admin routes
function requireAdminPassword(req, res, next) {
  const provided = req.headers['x-admin-password'] || req.body?.admin_password;
  if (provided !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

// ---------------------------------------------------------------------------
// GET /admin/settings
// Returns all platform settings (values masked for sensitive keys)
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
      key: row.key,
      value: SENSITIVE_KEYS.includes(row.key) && row.value
        ? row.value.slice(0, 6) + '…' + row.value.slice(-4)
        : row.value,
      is_set: !!row.value,
    }));
    return res.json({ ok: true, settings });
  })().catch(err => {
    return res.status(500).json({ ok: false, error: err.message });
  });
});

// ---------------------------------------------------------------------------
// POST /admin/settings
// Set one or more platform settings
// Body: { admin_password, settings: { key: value, ... } }
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
  })().catch(err => {
    return res.status(500).json({ ok: false, error: err.message });
  });
});

// ---------------------------------------------------------------------------
// GET /admin/diagnostics
// Shows users, their subscription state, vault doc counts, and post counts.
// Useful for debugging "account reset" / user_id mismatch issues.
// ---------------------------------------------------------------------------
router.get('/diagnostics', requireAdminPassword, (req, res) => {
  (async () => {
    const users = await db.prepare(`
      SELECT
        p.user_id,
        p.email,
        p.display_name,
        p.tenant_id                          AS profile_tenant_id,
        p.created_at                         AS profile_created_at,
        s.plan,
        s.status,
        s.current_period_end,
        s.paddle_subscription_id,
        (SELECT COUNT(*) FROM vault_documents  v WHERE v.user_id = p.user_id) AS vault_docs_total,
        (SELECT COUNT(*) FROM vault_documents  v WHERE v.user_id = p.user_id AND v.tenant_id = 'default') AS vault_docs_default_tenant,
        (SELECT COUNT(*) FROM generated_posts  g WHERE g.user_id = p.user_id) AS posts
      FROM user_profiles p
      LEFT JOIN user_subscriptions s ON s.user_id = p.user_id
      ORDER BY p.created_at DESC
      LIMIT 100
    `).all();

    return res.json({ ok: true, users });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// POST /admin/sync-subscription
// Force-syncs a user's subscription by email: searches Paddle for an active
// subscription, upserts it to the DB, and updates MailerLite.
// Body: { admin_password, email }
// ---------------------------------------------------------------------------
router.post('/sync-subscription', requireAdminPassword, (req, res) => {
  (async () => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: 'email is required' });

    const proPriceIds = [
      process.env.PADDLE_PRICE_ID_FOUNDING_1,
      process.env.PADDLE_PRICE_ID_FOUNDING_2,
      process.env.PADDLE_PRICE_ID_YEARLY,
    ].filter(Boolean);

    // Resolve user_id from email
    const profile = await db.prepare(
      'SELECT user_id FROM user_profiles WHERE email = ? LIMIT 1'
    ).get(email);
    if (!profile) return res.status(404).json({ ok: false, error: 'user not found' });
    const userId = profile.user_id;

    // Search Paddle for this email's customer + subscription
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

    // Sync MailerLite
    getUserEmailInfo(userId, 'default').then(user => {
      if (!user) return;
      if (plan === 'pro' && ['active', 'trialing'].includes(subscription.status)) {
        mailerlite.upgradeSubscriberToPro(user.email, user.name).catch(() => {});
      } else if (['canceled', 'past_due', 'paused'].includes(subscription.status)) {
        mailerlite.downgradeSubscriberToFree(user.email, user.name).catch(() => {});
      }
    }).catch(() => {});

    console.log(`[admin] force-synced subscription for ${email}: plan=${plan} status=${subscription.status}`);
    return res.json({ ok: true, email, userId, plan, status: subscription.status, subscriptionId: subscription.id });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

module.exports = router;

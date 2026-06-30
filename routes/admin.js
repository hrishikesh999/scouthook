'use strict';

const express = require('express');
const router  = express.Router();
const { getSetting, setSetting, getAllSettings, db } = require('../db');
const { pool } = require('../db/pg');
const {
  getPaddle, upsertSubscription, getUserPlan,
  INTERNAL_POST_CAP_FREE, INTERNAL_POST_CAP_PRO,
  INTERNAL_VISUAL_CAP_FREE, INTERNAL_VISUAL_CAP_PRO,
} = require('../services/subscription');
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
    'pexels_api_key',
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
    'pexels_api_key',
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
    const plan    = !priceId ? 'pro' : (proPriceIds.includes(priceId) ? 'pro' : 'expired');

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
        mailerlite.downgradeSubscriber(user.email, user.name).catch(() => {});
      }
    }).catch(() => {});

    console.log(`[admin] force-synced subscription for ${email}: plan=${plan} status=${subscription.status}`);
    return res.json({ ok: true, email, userId, plan, status: subscription.status, subscriptionId: subscription.id });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// POST /admin/grant-lifetime
// Grants a user full Pro access permanently (no Paddle subscription required).
// Admin-only — never visible to end users.
// Body: { email }
// ---------------------------------------------------------------------------
router.post('/grant-lifetime', requireAdminPassword, (req, res) => {
  (async () => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: 'email required' });

    const user = await db.prepare('SELECT user_id FROM user_profiles WHERE email = ?').get(email);
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    const userId = user.user_id;

    await db.prepare(`
      INSERT INTO user_subscriptions (user_id, plan, status, paddle_customer_id, paddle_subscription_id,
        current_period_end, canceled_at, price_id, extra_workspaces, updated_at)
      VALUES (?, 'pro', 'lifetime', NULL, NULL, NULL, NULL, NULL, 0, now())
      ON CONFLICT (user_id) DO UPDATE SET
        plan = 'pro', status = 'lifetime',
        paddle_customer_id = NULL, paddle_subscription_id = NULL,
        current_period_end = NULL, canceled_at = NULL, price_id = NULL,
        updated_at = now()
    `).run(userId);

    // Lift any workspace grace restrictions immediately.
    const { clearWorkspaceGracePeriods } = require('../lib/workspaceUtils');
    await clearWorkspaceGracePeriods(userId);

    console.log(`[admin] granted lifetime plan to ${email} (${userId})`);
    return res.json({ ok: true, userId, email });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// POST /admin/revoke-lifetime
// Reverts a lifetime user back to expired (no active plan).
// Body: { email }
// ---------------------------------------------------------------------------
router.post('/revoke-lifetime', requireAdminPassword, (req, res) => {
  (async () => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: 'email required' });

    const user = await db.prepare('SELECT user_id FROM user_profiles WHERE email = ?').get(email);
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    const userId = user.user_id;

    const sub = await db.prepare('SELECT status FROM user_subscriptions WHERE user_id = ?').get(userId);
    if (!sub || sub.status !== 'lifetime') {
      return res.status(400).json({ ok: false, error: 'user_does_not_have_lifetime_plan' });
    }

    await db.prepare(`
      UPDATE user_subscriptions
      SET plan = 'expired', status = 'expired', paddle_customer_id = NULL,
          paddle_subscription_id = NULL, current_period_end = NULL,
          canceled_at = NULL, price_id = NULL, updated_at = now()
      WHERE user_id = ?
    `).run(userId);

    console.log(`[admin] revoked lifetime plan from ${email} (${userId})`);
    return res.json({ ok: true, userId, email });
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

// ---------------------------------------------------------------------------
// GET /admin/dashboard/metrics?start=&end=&granularity=day|week|month
// ---------------------------------------------------------------------------
router.get('/dashboard/metrics', requireAdminPassword, (req, res) => {
  (async () => {
    const GRAN_MAP = { day: 'day', week: 'week', month: 'month' };
    const gran = GRAN_MAP[req.query.granularity] || 'day';
    const start = req.query.start || '2020-01-01';
    const end   = req.query.end   || new Date().toISOString().slice(0, 10);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ ok: false, error: 'start/end must be ISO dates' });
    }

    const bucket = `date_trunc('${gran}', created_at)::date`;

    const [signupsR, upgradesR, cancelsR, postsR, linkedinR, mrrR, trialExpiredR, funnelOnboardingR, funnelFirstPostR] =
      await Promise.all([
        // signups
        db.prepare(`
          SELECT ${bucket} AS bucket, COUNT(*) AS count
          FROM user_profiles WHERE created_at BETWEEN ? AND ?::date + INTERVAL '1 day'
          GROUP BY 1 ORDER BY 1
        `).all(start, end),
        // paid upgrades
        db.prepare(`
          SELECT date_trunc('${gran}', updated_at)::date AS bucket, COUNT(*) AS count
          FROM user_subscriptions
          WHERE status = 'active' AND plan = 'pro'
            AND updated_at BETWEEN ? AND ?::date + INTERVAL '1 day'
          GROUP BY 1 ORDER BY 1
        `).all(start, end),
        // cancellations
        db.prepare(`
          SELECT date_trunc('${gran}', canceled_at)::date AS bucket, COUNT(*) AS count
          FROM user_subscriptions
          WHERE status = 'canceled' AND canceled_at IS NOT NULL
            AND canceled_at BETWEEN ? AND ?::date + INTERVAL '1 day'
          GROUP BY 1 ORDER BY 1
        `).all(start, end),
        // posts created
        db.prepare(`
          SELECT ${bucket} AS bucket, COUNT(*) AS count
          FROM generated_posts WHERE created_at BETWEEN ? AND ?::date + INTERVAL '1 day'
          GROUP BY 1 ORDER BY 1
        `).all(start, end),
        // linkedin connections
        db.prepare(`
          SELECT ${bucket} AS bucket, COUNT(*) AS count
          FROM linkedin_connections WHERE created_at BETWEEN ? AND ?::date + INTERVAL '1 day'
          GROUP BY 1 ORDER BY 1
        `).all(start, end),
        // MRR snapshot
        db.prepare(`
          SELECT COUNT(*) AS active_pro FROM user_subscriptions
          WHERE status = 'active' AND plan = 'pro'
        `).get(),
        // trial expired — trial ended in period without converting to active
        db.prepare(`
          SELECT date_trunc('${gran}', trial_ends_at)::date AS bucket, COUNT(*) AS count
          FROM user_subscriptions
          WHERE trial_ends_at IS NOT NULL
            AND trial_ends_at BETWEEN ? AND ?::date + INTERVAL '1 day'
            AND status != 'active'
          GROUP BY 1 ORDER BY 1
        `).all(start, end),
        // funnel: onboarding completed in period
        db.prepare(`
          SELECT COUNT(*) AS n FROM user_profiles
          WHERE onboarding_completed_at IS NOT NULL
            AND onboarding_completed_at BETWEEN ? AND ?::date + INTERVAL '1 day'
        `).get(start, end),
        // funnel: users whose first-ever post was created in this period
        db.prepare(`
          SELECT COUNT(*) AS n FROM (
            SELECT wm.user_id
            FROM generated_posts gp
            JOIN workspace_members wm ON wm.workspace_id = gp.tenant_id
            GROUP BY wm.user_id
            HAVING MIN(gp.created_at) BETWEEN ? AND ?::date + INTERVAL '1 day'
          ) sub
        `).get(start, end),
      ]);

    // platform_events — degrade gracefully if table doesn't exist yet
    let disconnectsR = [], loginsR = [];
    try {
      [disconnectsR, loginsR] = await Promise.all([
        db.prepare(`
          SELECT date_trunc('${gran}', created_at)::date AS bucket, COUNT(*) AS count
          FROM platform_events WHERE event_type = 'linkedin_disconnect'
            AND created_at BETWEEN ? AND ?::date + INTERVAL '1 day'
          GROUP BY 1 ORDER BY 1
        `).all(start, end),
        db.prepare(`
          SELECT date_trunc('${gran}', created_at)::date AS bucket, COUNT(*) AS count
          FROM platform_events WHERE event_type = 'login'
            AND created_at BETWEEN ? AND ?::date + INTERVAL '1 day'
          GROUP BY 1 ORDER BY 1
        `).all(start, end),
      ]);
    } catch { /* table not yet created */ }

    const toSeries = rows => rows.map(r => ({ bucket: r.bucket, count: Number(r.count) }));
    const sumSeries = rows => rows.reduce((a, r) => a + Number(r.count), 0);

    return res.json({
      ok: true,
      period: { start, end, granularity: gran },
      mrr_estimate: (Number(mrrR?.active_pro) || 0) * 29,
      series: {
        signups:              toSeries(signupsR),
        paid_upgrades:        toSeries(upgradesR),
        cancellations:        toSeries(cancelsR),
        posts_created:        toSeries(postsR),
        linkedin_connections: toSeries(linkedinR),
        linkedin_disconnects: toSeries(disconnectsR),
        logins:               toSeries(loginsR),
        trial_expired:        toSeries(trialExpiredR),
      },
      funnel: {
        signups:    sumSeries(signupsR),
        onboarding: Number(funnelOnboardingR?.n) || 0,
        first_post: Number(funnelFirstPostR?.n)  || 0,
        upgrades:   sumSeries(upgradesR),
      },
    });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// GET /admin/users?limit=100&offset=0&search=
// ---------------------------------------------------------------------------
router.get('/users', requireAdminPassword, (req, res) => {
  (async () => {
    const limit  = Math.min(Math.max(parseInt(req.query.limit)  || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const search = (req.query.search || '').trim();

    let whereClause = '';
    let params = [];
    if (search) {
      whereClause = "WHERE up.email ILIKE ? OR up.display_name ILIKE ?";
      params = [`%${search}%`, `%${search}%`];
    }

    const users = await db.prepare(`
      SELECT
        up.user_id, up.email, up.display_name, up.country, up.created_at,
        us.plan, us.status, us.trial_ends_at,
        (SELECT COUNT(*) FROM generated_posts gp
         JOIN workspace_members wm ON wm.workspace_id = gp.tenant_id
         WHERE wm.user_id = up.user_id) AS post_count,
        (SELECT MAX(gp.created_at) FROM generated_posts gp
         JOIN workspace_members wm ON wm.workspace_id = gp.tenant_id
         WHERE wm.user_id = up.user_id) AS last_active
      FROM user_profiles up
      LEFT JOIN user_subscriptions us ON us.user_id = up.user_id
      ${whereClause}
      ORDER BY last_active DESC NULLS LAST
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return res.json({ ok: true, users });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// GET /admin/users/:userId
// ---------------------------------------------------------------------------
router.get('/users/:userId', requireAdminPassword, (req, res) => {
  (async () => {
    const { userId } = req.params;

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

    const [profile, subscription, workspaces, connections, profiles, recentPosts, postsThisMonth, visualsThisMonth] =
      await Promise.all([
        db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').get(userId),
        db.prepare('SELECT plan, status, trial_ends_at, current_period_end, canceled_at FROM user_subscriptions WHERE user_id = ?').get(userId),
        db.prepare(`
          SELECT w.id, w.name, w.deleted_at,
                 (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = w.id) AS member_count,
                 (SELECT COUNT(*) FROM generated_posts WHERE tenant_id = w.id) AS post_count
          FROM workspaces w
          JOIN workspace_members wm ON wm.workspace_id = w.id
          WHERE wm.user_id = ?
          ORDER BY w.created_at ASC
        `).all(userId),
        db.prepare(`
          SELECT account_type, display_name, expires_at
          FROM linkedin_connections lc
          JOIN workspace_members wm ON wm.workspace_id = lc.workspace_id
          WHERE wm.user_id = ?
        `).all(userId),
        db.prepare(`
          SELECT display_name, onboarding_complete, voice_profile_completion_pct
          FROM profiles p
          JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
          WHERE wm.user_id = ?
        `).all(userId),
        db.prepare(`
          SELECT gp.content, gp.archetype_used, gp.status, gp.created_at
          FROM generated_posts gp
          JOIN workspace_members wm ON wm.workspace_id = gp.tenant_id
          WHERE wm.user_id = ?
          ORDER BY gp.created_at DESC
          LIMIT 10
        `).all(userId),
        db.prepare(`
          SELECT COUNT(*) AS cnt
          FROM generated_posts
          WHERE user_id = ? AND passed_gate = 1 AND created_at >= ?
        `).get(userId, monthStart),
        db.prepare(`
          SELECT COUNT(*) AS cnt
          FROM visual_generation_log
          WHERE user_id = ? AND created_at >= ?
        `).get(userId, monthStart),
      ]);

    if (!profile) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const userIsPro = subscription?.plan === 'pro';
    const usage = {
      posts_this_month:    parseInt(postsThisMonth?.cnt  ?? 0, 10),
      visuals_this_month:  parseInt(visualsThisMonth?.cnt ?? 0, 10),
      internal_post_cap:   userIsPro ? INTERNAL_POST_CAP_PRO   : INTERNAL_POST_CAP_FREE,
      internal_visual_cap: userIsPro ? INTERNAL_VISUAL_CAP_PRO : INTERNAL_VISUAL_CAP_FREE,
    };

    return res.json({ ok: true, profile, subscription, workspaces, connections, profiles, recent_posts: recentPosts, usage });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// GET /admin/users/:userId/activity
// Returns a unified, time-sorted activity log for a single user, drawn from:
//   platform_events  — login, linkedin_disconnect, email_opened, email_clicked, upgrade
//   linkedin_connections — linkedin_connect (derived; authorized_by = userId)
//   user_profiles    — onboarding_complete (derived)
//   generated_posts  — post_created, post_published (derived)
//   email_log        — email_sent (derived)
// ---------------------------------------------------------------------------
router.get('/users/:userId/activity', requireAdminPassword, (req, res) => {
  (async () => {
    const { userId } = req.params;

    const rows = await pool.query(`
      SELECT created_at, event_type AS event, meta FROM (

        -- Logins
        SELECT created_at, 'login' AS event_type, NULL AS meta
        FROM platform_events WHERE user_id = $1 AND event_type = 'login'

        UNION ALL

        -- LinkedIn connected (derived — authorized_by is the user who clicked Connect)
        SELECT created_at, 'linkedin_connect', display_name
        FROM linkedin_connections WHERE authorized_by = $1

        UNION ALL

        -- LinkedIn disconnected
        SELECT created_at, 'linkedin_disconnect', NULL
        FROM platform_events WHERE user_id = $1 AND event_type = 'linkedin_disconnect'

        UNION ALL

        -- Onboarding completed
        SELECT onboarding_completed_at, 'onboarding_complete', NULL
        FROM user_profiles WHERE user_id = $1 AND onboarding_completed_at IS NOT NULL

        UNION ALL

        -- Posts created
        SELECT created_at, 'post_created', LEFT(content, 80)
        FROM generated_posts WHERE user_id = $1

        UNION ALL

        -- Posts published
        SELECT published_at, 'post_published', LEFT(content, 80)
        FROM generated_posts WHERE user_id = $1 AND status = 'published' AND published_at IS NOT NULL

        UNION ALL

        -- Emails sent
        SELECT sent_at, 'email_sent', template
        FROM email_log WHERE user_id = $1

        UNION ALL

        -- Email opened / clicked (Resend webhook)
        SELECT created_at, event_type, metadata->>'template'
        FROM platform_events WHERE user_id = $1 AND event_type IN ('email_opened', 'email_clicked')

        UNION ALL

        -- Upgrade
        SELECT created_at, 'upgrade', NULL
        FROM platform_events WHERE user_id = $1 AND event_type = 'upgrade'

      ) sub
      WHERE created_at IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 200
    `, [userId]);

    return res.json({ ok: true, activity: rows.rows });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// POST /admin/users/:userId/extend-trial
// Body: { days: 7 }
// ---------------------------------------------------------------------------
router.post('/users/:userId/extend-trial', requireAdminPassword, (req, res) => {
  (async () => {
    const { userId } = req.params;
    const days = parseInt(req.body?.days);
    if (!Number.isFinite(days) || days < 1 || days > 90) {
      return res.status(400).json({ ok: false, error: 'days must be 1–90' });
    }

    await db.prepare(`
      UPDATE user_subscriptions
      SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, NOW()), NOW()) + ($1 * INTERVAL '1 day'),
          status = 'trialing'
      WHERE user_id = $2
    `).run(days, userId);

    return res.json({ ok: true });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// GET /admin/feedback?category=feature_request|bug_report|improvement
// ---------------------------------------------------------------------------
router.get('/feedback', requireAdminPassword, (req, res) => {
  (async () => {
    const { category } = req.query;
    const VALID_CATS = ['feature_request', 'bug_report', 'improvement'];

    let rows;
    if (category && VALID_CATS.includes(category)) {
      rows = await db.prepare(`
        SELECT f.id, f.message, f.rating, f.category, f.page_url, f.created_at,
               up.email, up.display_name
        FROM feedback f
        JOIN user_profiles up ON up.user_id = f.user_id
        WHERE f.category = ?
        ORDER BY f.created_at DESC
      `).all(category);
    } else {
      rows = await db.prepare(`
        SELECT f.id, f.message, f.rating, f.category, f.page_url, f.created_at,
               up.email, up.display_name
        FROM feedback f
        JOIN user_profiles up ON up.user_id = f.user_id
        ORDER BY f.created_at DESC
      `).all();
    }

    return res.json({ ok: true, feedback: rows });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// GET /admin/feedback/:id  — full feedback detail
// ---------------------------------------------------------------------------
router.get('/feedback/:id', requireAdminPassword, (req, res) => {
  (async () => {
    const feedbackId = parseInt(req.params.id);
    if (!Number.isFinite(feedbackId)) return res.status(400).json({ ok: false, error: 'invalid id' });

    const row = await db.prepare(`
      SELECT f.id, f.message, f.rating, f.category, f.page_url, f.created_at,
             up.email, up.display_name
      FROM feedback f
      JOIN user_profiles up ON up.user_id = f.user_id
      WHERE f.id = ?
    `).get(feedbackId);
    if (!row) return res.status(404).json({ ok: false, error: 'feedback_not_found' });

    return res.json({ ok: true, feedback: row });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// GET /admin/support?status=new|open|resolved
// ---------------------------------------------------------------------------
router.get('/support', requireAdminPassword, (req, res) => {
  (async () => {
    const { status } = req.query;
    const VALID_STATUSES = ['new', 'open', 'resolved'];

    let rows;
    if (status && VALID_STATUSES.includes(status)) {
      rows = await db.prepare(`
        SELECT sr.id, sr.topic, sr.message, sr.status, sr.admin_note, sr.created_at,
               up.email, up.display_name, us.plan
        FROM support_requests sr
        JOIN user_profiles up ON up.user_id = sr.user_id
        LEFT JOIN user_subscriptions us ON us.user_id = sr.user_id
        WHERE sr.status = ?
        ORDER BY sr.created_at DESC
      `).all(status);
    } else {
      rows = await db.prepare(`
        SELECT sr.id, sr.topic, sr.message, sr.status, sr.admin_note, sr.created_at,
               up.email, up.display_name, us.plan
        FROM support_requests sr
        JOIN user_profiles up ON up.user_id = sr.user_id
        LEFT JOIN user_subscriptions us ON us.user_id = sr.user_id
        ORDER BY sr.created_at DESC
      `).all();
    }

    return res.json({ ok: true, tickets: rows });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// GET /admin/support/:id  — full ticket detail with reply history
// ---------------------------------------------------------------------------
router.get('/support/:id', requireAdminPassword, (req, res) => {
  (async () => {
    const ticketId = parseInt(req.params.id);
    if (!Number.isFinite(ticketId)) return res.status(400).json({ ok: false, error: 'invalid id' });

    const row = await db.prepare(`
      SELECT sr.id, sr.topic, sr.message, sr.status, sr.admin_note, sr.replies, sr.created_at,
             up.email, up.display_name, us.plan, us.status AS sub_status
      FROM support_requests sr
      JOIN user_profiles up ON up.user_id = sr.user_id
      LEFT JOIN user_subscriptions us ON us.user_id = sr.user_id
      WHERE sr.id = ?
    `).get(ticketId);
    if (!row) return res.status(404).json({ ok: false, error: 'ticket_not_found' });

    row.replies = typeof row.replies === 'string' ? JSON.parse(row.replies) : (row.replies || []);
    return res.json({ ok: true, ticket: row });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// POST /admin/support/:id/reply
// Body: { message: "...", fromEmail: "admin@example.com" }
// ---------------------------------------------------------------------------
router.post('/support/:id/reply', requireAdminPassword, (req, res) => {
  (async () => {
    const ticketId = parseInt(req.params.id);
    if (!Number.isFinite(ticketId)) return res.status(400).json({ ok: false, error: 'invalid id' });

    const { message, fromEmail } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ ok: false, error: 'message is required' });
    }

    const ticket = await db.prepare(`
      SELECT sr.id, sr.topic, sr.message AS original_message, sr.status, sr.user_id,
             up.email, up.display_name
      FROM support_requests sr
      JOIN user_profiles up ON up.user_id = sr.user_id
      WHERE sr.id = ?
    `).get(ticketId);
    if (!ticket) return res.status(404).json({ ok: false, error: 'ticket_not_found' });

    const { sendEmail } = require('../emails');
    const appUrl = process.env.APP_URL || '';
    await sendEmail('admin-support-reply', ticket.email, {
      name:             (ticket.display_name || '').split(' ')[0] || 'there',
      topic:            ticket.topic || 'Support request',
      admin_message:    message.trim(),
      original_message: ticket.original_message || '',
      app_url:          appUrl,
    }, { replyTo: fromEmail || undefined });

    const replyEntry = JSON.stringify({
      message:    message.trim(),
      from_email: fromEmail || null,
      sent_at:    new Date().toISOString(),
    });

    // Auto-advance from 'new' → 'open' on first reply; leave open/resolved unchanged
    const newStatus = ticket.status === 'new' ? 'open' : ticket.status;

    await db.prepare(`
      UPDATE support_requests
      SET replies = replies || ?::jsonb, admin_note = ?, status = ?
      WHERE id = ?
    `).run(replyEntry, message.trim(), newStatus, ticketId);

    return res.json({ ok: true, status: newStatus });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// POST /admin/support/:id/status
// Body: { status: 'new'|'open'|'resolved' }
// ---------------------------------------------------------------------------
router.post('/support/:id/status', requireAdminPassword, (req, res) => {
  (async () => {
    const ticketId = parseInt(req.params.id);
    if (!Number.isFinite(ticketId)) return res.status(400).json({ ok: false, error: 'invalid id' });

    const { status } = req.body || {};
    if (!['new', 'open', 'resolved'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'status must be new, open, or resolved' });
    }

    const row = await db.prepare(
      'UPDATE support_requests SET status = ? WHERE id = ? RETURNING id'
    ).get(status, ticketId);
    if (!row) return res.status(404).json({ ok: false, error: 'ticket_not_found' });

    return res.json({ ok: true });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// POST /admin/feedback/:id/reply
// Body: { message: "..." }
// ---------------------------------------------------------------------------
router.post('/feedback/:id/reply', requireAdminPassword, (req, res) => {
  (async () => {
    const feedbackId = parseInt(req.params.id);
    if (!Number.isFinite(feedbackId)) return res.status(400).json({ ok: false, error: 'invalid id' });

    const { message, fromEmail } = req.body || {};
    if (!message || !message.trim()) return res.status(400).json({ ok: false, error: 'message required' });

    const row = await db.prepare(`
      SELECT f.id, f.message, f.category, f.page_url,
             up.email, up.display_name
      FROM feedback f
      JOIN user_profiles up ON up.user_id = f.user_id
      WHERE f.id = ?
    `).get(feedbackId);
    if (!row) return res.status(404).json({ ok: false, error: 'feedback_not_found' });

    const { sendEmail } = require('../emails');
    await sendEmail('feedback-reply', row.email, {
      name: row.display_name || row.email,
      admin_message: message.trim(),
      original_message: row.message || '',
      category: row.category || '',
    }, { replyTo: fromEmail || undefined });

    return res.json({ ok: true });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

module.exports = router;

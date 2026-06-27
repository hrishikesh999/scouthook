'use strict';

const express = require('express');
const { Environment } = require('@paddle/paddle-node-sdk');
const router = express.Router();
const { sendEmailToUser, getUserEmailInfo } = require('../emails');
const mailerlite = require('../services/mailerlite');
const {
  getPaddle,
  getPaddleEnvironment,
  getUserSubscription,
  getPaddleCustomerId,
  getFoundingTierInfo,
  canGeneratePost,
  canGenerateVisual,
  canUploadVaultDoc,
  upsertSubscription,
} = require('../services/subscription');
const { enforceWorkspaceLimitGrace, clearWorkspaceGracePeriods } = require('../lib/workspaceUtils');
const { rankPlan, getWorkspaceLimit } = require('../lib/planFeatures');
const { getUserPlan } = require('../services/subscription');
const { db: billingDb } = require('../db');

/** Paddle REST / JS may use camelCase or snake_case; values can be object or JSON string. */
function getTransactionCustomUserId(transaction) {
  if (!transaction) return null;
  let raw = transaction.customData ?? transaction.custom_data;
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw.userId ?? raw.user_id;
  return typeof v === 'string' && v.length ? v : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTransactionSubscriptionId(tr) {
  if (!tr) return null;
  return tr.subscriptionId ?? tr.subscription_id ?? null;
}

function getTransactionCustomerIdFromTx(tr) {
  if (!tr) return null;
  return tr.customerId ?? tr.customer_id ?? null;
}

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ ok: false, error: 'unauthenticated' });
  next();
}

// ---------------------------------------------------------------------------
// GET /api/billing/config
// Returns public Paddle config for the frontend (client token, env, price IDs).
// Includes the current founding tier so the UI can display the right price
// and badge without any frontend logic.
// No auth required — these are non-secret client-side values.
// ---------------------------------------------------------------------------
router.get('/config', async (req, res) => {
  const tierInfo = await getFoundingTierInfo();
  const paddleEnv = getPaddleEnvironment();
  return res.json({
    ok: true,
    clientToken:    process.env.PADDLE_CLIENT_TOKEN || '',
    env:            paddleEnv === Environment.production ? 'production' : 'sandbox',
    // priceIdMonthly returns the *currently active* tier price ID (29/39)
    priceIdMonthly:  tierInfo.priceId,
    priceIdYearly:   process.env.PADDLE_PRICE_ID_YEARLY || '',
    proMonthlyPrice:  tierInfo.price,
  });
});

// ---------------------------------------------------------------------------
// GET /api/billing/subscription
// Returns plan, status, period end, and current usage vs limits.
// Live-syncs from Paddle when the stored subscription data is stale:
//   - current_period_end has passed (renewal likely happened), or
//   - updated_at is more than 24 hours old (catch any Paddle-side changes).
// This removes the need for webhooks to keep renewal state current.
// ---------------------------------------------------------------------------
router.get('/subscription', requireAuth, async (req, res) => {
  const userId = req.userId;

  // Check if a live refresh is needed before reading from DB
  const { db } = require('../db');
  const proPriceIds = [
    process.env.PADDLE_PRICE_ID_PRO,
    process.env.PADDLE_PRICE_ID_YEARLY,
  ].filter(Boolean);

  try {
    const row = await db.prepare(
      'SELECT paddle_customer_id, paddle_subscription_id, status, current_period_end, updated_at FROM user_subscriptions WHERE user_id = ?'
    ).get(userId);

    if (row?.paddle_subscription_id && row?.status !== 'lifetime') {
      // ── Existing row: refresh if stale ────────────────────────────────────
      const now = Date.now();
      const periodEnd  = row.current_period_end ? new Date(row.current_period_end).getTime() : 0;
      const updatedAt  = row.updated_at         ? new Date(row.updated_at).getTime()         : 0;
      const stale24h   = (now - updatedAt) > 24 * 60 * 60 * 1000;
      const periodOver = periodEnd > 0 && periodEnd < now;

      if (stale24h || periodOver) {
        try {
          const paddle = getPaddle();
          const subscription = await paddle.subscriptions.get(row.paddle_subscription_id);
          if (subscription) {
            const addonPriceIdStale = process.env.PADDLE_PRICE_ID_WORKSPACE_ADDON || null;
            const basePlanItemStale = addonPriceIdStale
              ? (subscription.items?.find(i => i.price?.id !== addonPriceIdStale) ?? subscription.items?.[0])
              : subscription.items?.[0];
            const priceId = basePlanItemStale?.price?.id ?? null;
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

            // Sync extra_workspaces from the live subscription so Paddle-side
            // addon changes (refund, support removal) are reflected here too.
            if (addonPriceIdStale) {
              const addonItemStale = subscription.items?.find(i => i.price?.id === addonPriceIdStale);
              const syncedExtra = addonItemStale?.quantity ?? 0;
              billingDb.prepare(
                'UPDATE user_subscriptions SET extra_workspaces = ?, updated_at = now() WHERE user_id = ?'
              ).run(syncedExtra, userId).catch(err =>
                console.warn('[billing] stale-refresh extra_workspaces sync error (non-fatal):', err.message)
              );
            }

            // Keep MailerLite groups in sync whenever the stale-refresh updates
            // subscription state (e.g. on renewal, plan change, or cancellation).
            getUserEmailInfo(userId).then(user => {
              if (!user) return;
              if (['solo', 'pro'].includes(plan) && ['active', 'trialing'].includes(subscription.status)) {
                mailerlite.upgradeSubscriberToPaid(user.email, user.name).catch(() => {});
              } else if (['canceled', 'past_due', 'paused'].includes(subscription.status)) {
                mailerlite.downgradeSubscriber(user.email, user.name).catch(() => {});
              }
            }).catch(() => {});

            // Send payment-failed email once per billing cycle when status becomes past_due.
            if (subscription.status === 'past_due') {
              const dedupKey = `past_due:${subscription.currentBillingPeriod?.endsAt || 'unknown'}`;
              const portalUrl = process.env.PADDLE_CUSTOMER_PORTAL_URL || (process.env.APP_URL ? `${process.env.APP_URL}/billing.html` : '');
              sendEmailToUser(userId, 'payment-failed', { portal_url: portalUrl },
                { dedupKey, withinHours: 7 * 24 });
            }
          }
        } catch (syncErr) {
          // Non-fatal — serve cached DB value on Paddle API errors
          console.warn('[billing] subscription live-sync failed (non-fatal):', syncErr.message);
        }
      }
    } else {
      // ── No local row: attempt recovery by looking up the user in Paddle ──
      // This handles DB resets (e.g. ephemeral Render disk) where the local
      // subscription record was wiped but Paddle still has the subscription.
      const email = req.user?.email || null;
      if (email) {
        try {
          const paddle = getPaddle();
          // Search Paddle customers by email to find a matching customer ID
          const customerList = await paddle.customers.list({ email: [email] });
          const customers = customerList?.data ?? [];
          let recovered = null;

          for (const customer of customers) {
            const subList = await paddle.subscriptions.list({ customerId: [customer.id] });
            const subs = subList?.data ?? [];
            // Prefer active/trialing; otherwise the most recent non-canceled subscription
            const best = subs.find(s => ['active', 'trialing'].includes(s.status))
              ?? subs.find(s => s.status !== 'canceled')
              ?? subs[0]
              ?? null;
            if (best) { recovered = best; break; }
          }

          if (recovered) {
            const priceId = recovered.items?.[0]?.price?.id ?? null;
            const plan    = !priceId ? 'pro' : (proPriceIds.includes(priceId) ? 'pro' : 'expired');
            await upsertSubscription({
              userId,
              paddleCustomerId:     recovered.customerId,
              paddleSubscriptionId: recovered.id,
              plan,
              status:               recovered.status,
              currentPeriodEnd:     recovered.currentBillingPeriod?.endsAt
                                      ? new Date(recovered.currentBillingPeriod.endsAt)
                                      : null,
              canceledAt:           recovered.canceledAt ? new Date(recovered.canceledAt) : null,
              priceId,
            });
            console.log(`[billing] recovered subscription for userId=${userId} email=${email} subId=${recovered.id}`);
          }
        } catch (recoverErr) {
          // Non-fatal — if Paddle lookup fails just return current (free) state
          console.warn('[billing] subscription recovery from Paddle failed (non-fatal, will show as expired):', recoverErr.message);
        }
      }
    }
  } catch (checkErr) {
    console.warn('[billing] subscription stale-check failed (non-fatal):', checkErr.message);
  }

  const [sub, genCheck, visualCheck, vaultCheck, wsStats] = await Promise.all([
    getUserSubscription(userId),
    canGeneratePost(userId),
    canGenerateVisual(userId),
    canUploadVaultDoc(userId),
    billingDb.prepare(`
      SELECT
        COUNT(*) AS owned_count,
        SUM(CASE WHEN grace_expires_at IS NOT NULL THEN 1 ELSE 0 END) AS grace_count
      FROM workspaces w
      JOIN workspace_members wm ON wm.workspace_id = w.id
      WHERE wm.user_id = ? AND wm.role = 'owner' AND w.deleted_at IS NULL
    `).get(userId).catch(() => null),
  ]);

  const extraWorkspaces = sub.extra_workspaces ?? 0;
  // Only flag app-level trials (no price_id = no Paddle subscription yet).
  // Paddle-managed trials have their own status lifecycle; excluding them here
  // prevents a false-positive banner during the Paddle trial→active transition window.
  const trialExpired = sub.status === 'trialing'
    && !sub.price_id
    && !!sub.trial_ends_at
    && new Date(sub.trial_ends_at) <= new Date();

  // Never expose the internal 'lifetime' status to users — they see 'active'.
  const effectiveStatus = sub.status === 'lifetime' ? 'active' : sub.status;

  return res.json({
    ok: true,
    plan: genCheck.plan,  // effective plan: 'expired' once trial/grace period has expired
    status: effectiveStatus,
    price_id: sub.price_id ?? null,
    current_period_end: sub.current_period_end ?? null,
    canceled_at: sub.canceled_at ?? null,
    trial_ends_at: sub.trial_ends_at ?? null,
    trial_expired: trialExpired,
    extra_workspaces: extraWorkspaces,
    workspace_limit: getWorkspaceLimit(genCheck.plan, extraWorkspaces),
    workspace_count: wsStats?.owned_count ?? 0,
    workspaces_in_grace: wsStats?.grace_count ?? 0,
    generations: {
      current: genCheck.current,
      limit: genCheck.limit === Infinity ? null : genCheck.limit,
    },
    visuals: {
      current: visualCheck.current,
      limit: visualCheck.limit === Infinity ? null : visualCheck.limit,
    },
    vault_docs: {
      current: vaultCheck.current,
      limit: vaultCheck.limit === Infinity ? null : vaultCheck.limit,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/billing/cancel
// Schedules cancellation of the active subscription at period end.
// ---------------------------------------------------------------------------
router.post('/cancel', requireAuth, async (req, res) => {
  const userId = req.userId;
  const sub = await getUserSubscription(userId);

  if (sub.status === 'lifetime') {
    return res.status(403).json({ ok: false, error: 'cannot_cancel_lifetime' });
  }
  if (!sub.paddle_subscription_id) {
    return res.status(400).json({ ok: false, error: 'no_active_subscription' });
  }
  if (sub.status === 'canceled') {
    return res.status(400).json({ ok: false, error: 'already_canceled' });
  }

  const paddle = getPaddle();

  let canceledSubscription;
  try {
    canceledSubscription = await paddle.subscriptions.cancel(sub.paddle_subscription_id, {
      effectiveFrom: 'next_billing_period',
    });
  } catch (err) {
    console.error('[billing] paddle.subscriptions.cancel error:', err.message);
    return res.status(502).json({ ok: false, error: 'paddle_error', detail: err.message });
  }

  // Write the cancellation directly — no webhook needed.
  // Keep plan='pro' so the user retains access until current_period_end.
  try {
    await upsertSubscription({
      userId,
      paddleCustomerId:     sub.paddle_customer_id,
      paddleSubscriptionId: sub.paddle_subscription_id,
      plan:                 'pro',
      status:               'canceled',
      currentPeriodEnd:     canceledSubscription?.currentBillingPeriod?.endsAt
                              ? new Date(canceledSubscription.currentBillingPeriod.endsAt)
                              : (sub.current_period_end ? new Date(sub.current_period_end) : null),
      canceledAt:           canceledSubscription?.canceledAt ? new Date(canceledSubscription.canceledAt) : new Date(),
      priceId:              sub.price_id ?? null,
    });
  } catch (dbErr) {
    // The Paddle cancellation already succeeded — log but don't fail the response.
    // The next /subscription GET will live-sync and pick up the canceled status.
    console.error('[billing] cancel upsert error (non-fatal, will re-sync):', dbErr.message);
  }

  // Send cancellation confirmation email.
  const periodEnd = canceledSubscription?.currentBillingPeriod?.endsAt ?? sub.current_period_end;
  const accessEnds = periodEnd
    ? new Date(periodEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : 'the end of your current billing period';
  sendEmailToUser(userId, 'cancelled', {
    access_ends: accessEnds,
    app_url: process.env.APP_URL || '',
  }, { dedupKey: false });

  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/billing/portal
// Returns the Paddle customer portal URL.
// Primary path: createPortalSession() → authenticated one-time URL (user
// lands directly in their portal, no email/login required).
// Fallback: static PADDLE_CUSTOMER_PORTAL_URL env var (free users / API err).
// ---------------------------------------------------------------------------
router.get('/portal', requireAuth, async (req, res) => {
  const userId  = req.userId;
  const baseUrl = process.env.PADDLE_CUSTOMER_PORTAL_URL || '';

  // Try the authenticated session URL first (requires paddle_customer_id).
  // customerPortalSessions.create() returns a one-time authenticated URL —
  // the user lands directly in their portal with no email/login required.
  try {
    const customerId = await getPaddleCustomerId(userId);
    if (customerId) {
      const paddle  = getPaddle();
      // Pass empty subscriptionIds array to get the portal overview page
      const session = await paddle.customerPortalSessions.create(customerId, []);
      // SDK shape: session.urls.general.overview
      const portalUrl = session?.urls?.general?.overview ?? null;
      if (portalUrl) {
        console.log(`[billing] portal session created for userId=${userId} customerId=${customerId}`);
        return res.json({ ok: true, portalUrl });
      }
      console.warn('[billing] portal: session created but no overview URL. session.urls:', JSON.stringify(session?.urls));
    }
  } catch (err) {
    console.warn('[billing] portal: customerPortalSessions.create failed, falling back:', err.message);
  }

  // Fallback: static portal URL (email pre-fill best-effort)
  if (!baseUrl) {
    console.error('[billing] portal: PADDLE_CUSTOMER_PORTAL_URL is not set and createPortalSession failed');
    return res.status(503).json({ ok: false, error: 'portal_not_configured' });
  }

  const email = req.user?.email || '';
  const portalUrl = email
    ? `${baseUrl}?email=${encodeURIComponent(email)}`
    : baseUrl;

  return res.json({ ok: true, portalUrl });
});

// ---------------------------------------------------------------------------
// POST /api/billing/sync
// Called from the frontend immediately after checkout completes (via Paddle
// eventCallback) and again on the success-redirect page load.
// Looks up the user's active Paddle subscription directly via the API and
// creates/updates the user_subscriptions row — no webhook needed.
// ---------------------------------------------------------------------------
router.post('/sync', requireAuth, async (req, res) => {
  const userId = req.userId;
  const { transactionId } = req.body || {};

  const paddle = getPaddle();

  const proPriceIds = [
    process.env.PADDLE_PRICE_ID_PRO,
    process.env.PADDLE_PRICE_ID_YEARLY,
  ].filter(Boolean);

  let subscription = null;

  try {
    // Primary path: transaction ID → subscription ID → subscription details
    if (transactionId) {
      // subscription_id can be absent on the first GET right after checkout — brief poll.
      let transaction = null;
      const maxAttempts = 15;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        transaction = await paddle.transactions.get(transactionId);

        const txUserId = getTransactionCustomUserId(transaction);
        if (txUserId && txUserId !== userId) {
          console.warn(`[billing] sync userId mismatch: req=${userId} tx=${txUserId}`);
          return res.status(403).json({ ok: false, error: 'transaction_not_owned' });
        }

        if (getTransactionSubscriptionId(transaction)) break;
        if (attempt < maxAttempts - 1) await delay(450);
      }

      const subId = getTransactionSubscriptionId(transaction);
      if (subId) {
        subscription = await paddle.subscriptions.get(subId);
      } else if (transaction) {
        const txOwner = getTransactionCustomUserId(transaction);
        const custId = getTransactionCustomerIdFromTx(transaction);
        if (custId && txOwner === userId) {
          const result = await paddle.subscriptions.list({ customerId: [custId] });
          const subs = result?.data ?? [];
          subscription = subs.find(s => ['active', 'trialing'].includes(s.status)) ?? subs[0] ?? null;
        }
      }
    }

    // Fallback: look up via existing Paddle customer ID
    if (!subscription) {
      const customerId = await getPaddleCustomerId(userId);
      if (customerId) {
        const result = await paddle.subscriptions.list({ customerId: [customerId] });
        const subs = result?.data ?? [];
        // Prefer active/trialing, otherwise take the most recent
        subscription = subs.find(s => ['active', 'trialing'].includes(s.status)) ?? subs[0] ?? null;
      }
    }
  } catch (err) {
    console.error('[billing] sync error:', err.message);
    return res.status(502).json({ ok: false, error: 'paddle_error', detail: err.message });
  }

  if (!subscription) {
    return res.status(404).json({ ok: false, error: 'no_subscription_found' });
  }

  // Find the base plan price (first non-addon item) and the workspace addon item.
  const addonPriceIdForSync = process.env.PADDLE_PRICE_ID_WORKSPACE_ADDON || null;
  // When env var is unset, addonPriceIdForSync is null — the find predicate
  // becomes (i.price?.id !== null) which is true for all items (correct: no
  // addon to exclude, so the first item is the base plan item).
  // When the env var IS set, the predicate correctly skips the addon item.
  const basePlanItem  = addonPriceIdForSync
    ? (subscription.items?.find(i => i.price?.id !== addonPriceIdForSync) ?? subscription.items?.[0])
    : subscription.items?.[0];
  const addonItemSync = addonPriceIdForSync
    ? subscription.items?.find(i => i.price?.id === addonPriceIdForSync)
    : null;

  const priceId = basePlanItem?.price?.id ?? null;
  // Mirror the webhook's safe default: if priceId is absent from the REST payload
  // or not yet in our env list, keep the user on 'pro' rather than downgrading them.
  let plan;
  if (!priceId) {
    plan = 'pro'; // unknown price ID — assume pro, webhook will correct if wrong
  } else {
    plan = proPriceIds.includes(priceId) ? 'pro' : 'expired';
  }

  // Capture existing plan before the upsert so we can detect plan changes.
  const prevSub = await getUserSubscription(userId).catch(() => null);
  const prevPlan = prevSub?.plan ?? 'expired';

  try {
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
  } catch (err) {
    console.error('[billing] sync upsert error:', err.message);
    return res.status(500).json({ ok: false, error: 'db_error', detail: err.message });
  }

  // Sync extra_workspaces from the live Paddle subscription. Always write the
  // quantity (0 when the addon item is absent) so a Paddle-side removal is
  // reflected in the DB. Skipping when addonItemSync==null would leave a stale
  // non-zero value if the addon was voided or refunded outside the app.
  if (addonPriceIdForSync) {
    const syncedExtra = addonItemSync?.quantity ?? 0;
    billingDb.prepare(
      'UPDATE user_subscriptions SET extra_workspaces = ?, updated_at = now() WHERE user_id = ?'
    ).run(syncedExtra, userId).catch(err =>
      console.error('[billing] sync extra_workspaces error:', err.message)
    );
  }

  console.log(`[billing] sync userId=${userId} plan=${plan} status=${subscription.status}`);

  // Enforce workspace limits when the plan changes (fire-and-forget — never block the response).
  if (plan !== prevPlan) {
    if (rankPlan(plan) < rankPlan(prevPlan)) {
      // Downgrade — put excess workspaces into grace period
      billingDb.prepare('SELECT plan, extra_workspaces FROM user_subscriptions WHERE user_id = ?')
        .get(userId)
        .then(updated => enforceWorkspaceLimitGrace(userId, updated?.plan ?? plan, updated?.extra_workspaces ?? 0))
        .catch(err => console.error('[billing] enforceWorkspaceLimitGrace error:', err.message));
    } else {
      // Upgrade — clear any grace periods
      clearWorkspaceGracePeriods(userId)
        .catch(err => console.error('[billing] clearWorkspaceGracePeriods error:', err.message));
    }
  }

  // Send pro-activated email when a new pro subscription is created.
  // Deduplicate by subscription ID so we only send once per activation.
  if (plan === 'pro' && ['active', 'trialing'].includes(subscription.status)) {
    const renewsOn = subscription.currentBillingPeriod?.endsAt
      ? new Date(subscription.currentBillingPeriod.endsAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : '';
    sendEmailToUser(userId, 'pro-activated', {
      renews_on: renewsOn,
      app_url: process.env.APP_URL || '',
    }, { dedupKey: `pro-activated:${subscription.id}`, withinHours: 365 * 24 });
  }

  // Sync subscription state to Mailerlite (fire-and-forget, never throws).
  getUserEmailInfo(userId).then(user => {
    if (!user) return;
    if (['solo', 'pro'].includes(plan) && ['active', 'trialing'].includes(subscription.status)) {
      mailerlite.upgradeSubscriberToPaid(user.email, user.name).catch(() => {});
    } else if (['canceled', 'past_due', 'paused'].includes(subscription.status)) {
      mailerlite.downgradeSubscriber(user.email, user.name).catch(() => {});
    }
  }).catch(() => {});

  // Mark affiliate referral as converted on first confirmed payment
  require('../services/affiliates').markReferralConverted(userId).catch(() => {});

  return res.json({ ok: true, plan, status: subscription.status });
});

// ---------------------------------------------------------------------------
// POST /api/billing/upgrade
// Returns Paddle price config for upgrading to Solo or Pro.
// Frontend opens Paddle Checkout overlay, then calls POST /api/billing/sync.
// ---------------------------------------------------------------------------
router.post('/upgrade', requireAuth, async (req, res) => {
  const { plan } = req.body || {};
  if (!['pro'].includes(plan)) { // 'solo' is not currently available for purchase
    return res.status(400).json({ ok: false, error: 'invalid_plan' });
  }
  const tierInfo = await getFoundingTierInfo();
  const priceId = tierInfo.priceId;
  if (!priceId) {
    return res.status(500).json({ ok: false, error: 'price_not_configured' });
  }
  const sub = await getUserSubscription(req.userId);
  const alreadyTrialed = !!sub.trial_ends_at;
  return res.json({
    ok: true,
    priceId,
    ...(alreadyTrialed ? {} : { trialDays: 7 }),
    customData: { userId: req.userId, plan },
  });
});

// ---------------------------------------------------------------------------
// Shared helper: build the new items list for a workspace add-on update.
// Takes the current Paddle subscription and returns the items array to pass
// to subscriptions.update() or subscriptions.previewUpdate(). Keeps all
// active existing items and either increments the workspace-addon quantity
// or appends a new item if none exists yet.
// ---------------------------------------------------------------------------
function buildWorkspaceAddonItems(subscription, addonPriceId) {
  const currentItems = subscription.items ?? [];
  const newItems = currentItems
    .filter(i => i.status === 'active' || i.status === 'trialing')
    .map(i => ({
      priceId: i.price.id,
      quantity: i.price.id === addonPriceId ? i.quantity + 1 : i.quantity,
    }));
  // Check for the addon in the FILTERED list: an inactive addon would not be
  // in newItems (excluded by the filter above), so we must append a fresh one.
  // Using the unfiltered currentItems here would falsely suppress the append.
  const alreadyHasAddon = newItems.some(i => i.priceId === addonPriceId);
  if (!alreadyHasAddon) newItems.push({ priceId: addonPriceId, quantity: 1 });
  return newItems;
}

// ---------------------------------------------------------------------------
// POST /api/billing/workspace-preview
// Pro only (active Paddle subscription required). Returns the exact prorated
// charge Paddle will collect today and the new monthly total, so the UI can
// show a confirmation modal before committing.
// ---------------------------------------------------------------------------
router.post('/workspace-preview', requireAuth, async (req, res) => {
  const userId = req.userId;

  const addonPriceId = process.env.PADDLE_PRICE_ID_WORKSPACE_ADDON;
  if (!addonPriceId) {
    return res.status(500).json({ ok: false, error: 'price_not_configured' });
  }

  // Use getUserPlan() for the effective plan check — it applies trial expiry,
  // past_due grace window, and paused-status logic that sub.status alone doesn't.
  const effectivePlan = await getUserPlan(userId);
  if (effectivePlan !== 'pro') {
    return res.status(403).json({ ok: false, error: 'pro_required' });
  }

  const sub = await getUserSubscription(userId);

  // Lifetime users have no Paddle subscription — workspace slots are free for them.
  if (sub.status === 'lifetime') {
    return res.json({ ok: true, lifetime: true, immediate_total: null, immediate_currency: null, next_total: null, next_billed_at: null });
  }

  if (!sub.paddle_subscription_id) {
    return res.status(403).json({ ok: false, error: 'no_paddle_subscription' });
  }

  const paddle = getPaddle();
  let liveSubscription;
  try {
    liveSubscription = await paddle.subscriptions.get(sub.paddle_subscription_id);
  } catch (err) {
    console.error('[billing] workspace-preview: subscriptions.get error:', err.message);
    return res.status(502).json({ ok: false, error: 'paddle_error' });
  }

  const newItems = buildWorkspaceAddonItems(liveSubscription, addonPriceId);

  let preview;
  try {
    preview = await paddle.subscriptions.previewUpdate(sub.paddle_subscription_id, {
      items: newItems,
      prorationBillingMode: 'prorated_immediately',
    });
  } catch (err) {
    console.error('[billing] workspace-preview: previewUpdate error:', err.message);
    return res.status(502).json({ ok: false, error: 'paddle_error' });
  }

  const immediate = preview.immediateTransaction;
  const next      = preview.nextTransaction;

  return res.json({
    ok: true,
    immediate_total:    immediate?.details?.totals?.grandTotal ?? null,
    immediate_currency: immediate?.details?.totals?.currencyCode ?? liveSubscription.currencyCode,
    next_total:         next?.details?.totals?.grandTotal ?? null,
    next_billed_at:     liveSubscription.nextBilledAt ?? sub.current_period_end ?? null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/billing/add-workspace
// Pro only (active Paddle subscription required). Adds one workspace slot to
// the user's existing Paddle subscription via a subscription item update.
// Paddle prorates the charge immediately for the remainder of the billing
// period — no separate checkout, no second subscription.
// After a successful Paddle update, syncs extra_workspaces from the live
// subscription item quantity so the DB stays consistent.
// ---------------------------------------------------------------------------
router.post('/add-workspace', requireAuth, async (req, res) => {
  const userId = req.userId;

  const addonPriceId = process.env.PADDLE_PRICE_ID_WORKSPACE_ADDON;
  if (!addonPriceId) {
    return res.status(500).json({ ok: false, error: 'price_not_configured' });
  }

  // Use getUserPlan() for the effective plan check — it applies trial expiry,
  // past_due grace window, and paused-status logic that sub.status alone doesn't.
  const effectivePlan = await getUserPlan(userId);
  if (effectivePlan !== 'pro') {
    return res.status(403).json({ ok: false, error: 'pro_required' });
  }

  const sub = await getUserSubscription(userId);

  // Lifetime users have no Paddle subscription — grant the extra slot directly in the DB.
  if (sub.status === 'lifetime') {
    const newExtra = (sub.extra_workspaces ?? 0) + 1;
    const newLimit = getWorkspaceLimit('pro', newExtra);
    await billingDb.prepare(
      'UPDATE user_subscriptions SET extra_workspaces = ?, updated_at = now() WHERE user_id = ?'
    ).run(newExtra, userId);
    console.log(`[billing] add-workspace (lifetime) userId=${userId} extra_workspaces=${newExtra}`);
    return res.json({ ok: true, extra_workspaces: newExtra, workspace_limit: newLimit });
  }

  if (!sub.paddle_subscription_id) {
    return res.status(403).json({ ok: false, error: 'no_paddle_subscription' });
  }

  const paddle = getPaddle();
  let liveSubscription;
  try {
    liveSubscription = await paddle.subscriptions.get(sub.paddle_subscription_id);
  } catch (err) {
    console.error('[billing] add-workspace: subscriptions.get error:', err.message);
    return res.status(502).json({ ok: false, error: 'paddle_error' });
  }

  // Idempotency guard: compare the current Paddle quantity with what the DB
  // expects. If they already match (e.g. a duplicate request arrived before
  // the DB write completed), skip the Paddle update and return success.
  const currentAddonItem    = liveSubscription.items.find(i => i.price.id === addonPriceId);
  const currentPaddleQty    = currentAddonItem?.quantity ?? 0;
  const currentDbExtra      = sub.extra_workspaces ?? 0;
  if (currentPaddleQty > currentDbExtra) {
    // Paddle already has a higher quantity than the DB — likely a prior request
    // that succeeded in Paddle but failed to update the DB. Sync the DB and
    // return success without firing another Paddle update.
    const syncedLimit = getWorkspaceLimit(effectivePlan, currentPaddleQty);
    await billingDb.prepare(
      'UPDATE user_subscriptions SET extra_workspaces = ?, updated_at = now() WHERE user_id = ?'
    ).run(currentPaddleQty, userId).catch(err =>
      console.error('[billing] add-workspace idempotency sync error:', err.message)
    );
    console.log(`[billing] add-workspace idempotency: synced userId=${userId} extra=${currentPaddleQty}`);
    return res.json({ ok: true, extra_workspaces: currentPaddleQty, workspace_limit: syncedLimit });
  }

  const newItems = buildWorkspaceAddonItems(liveSubscription, addonPriceId);

  let updatedSubscription;
  try {
    updatedSubscription = await paddle.subscriptions.update(sub.paddle_subscription_id, {
      items: newItems,
      prorationBillingMode: 'prorated_immediately',
    });
  } catch (err) {
    console.error('[billing] add-workspace: subscriptions.update error:', err.message);
    return res.status(502).json({ ok: false, error: 'paddle_error', detail: err.message });
  }

  // Derive the new extra_workspaces count directly from the updated Paddle
  // subscription item quantity. This is idempotent: if the DB update was
  // previously skipped (e.g. server crash), re-running gives the right value.
  const addonItem        = updatedSubscription.items.find(i => i.price.id === addonPriceId);
  const newExtraCount    = addonItem?.quantity ?? 1;
  const newWorkspaceLimit = getWorkspaceLimit(effectivePlan, newExtraCount);

  try {
    await billingDb.prepare(
      'UPDATE user_subscriptions SET extra_workspaces = ?, updated_at = now() WHERE user_id = ?'
    ).run(newExtraCount, userId);
  } catch (dbErr) {
    // Paddle succeeded — log but don't fail. The next subscription GET will
    // re-read from Paddle and can correct the count.
    console.error('[billing] add-workspace: DB update error (non-fatal):', dbErr.message);
  }

  console.log(`[billing] add-workspace userId=${userId} extra_workspaces=${newExtraCount}`);
  return res.json({ ok: true, extra_workspaces: newExtraCount, workspace_limit: newWorkspaceLimit });
});

module.exports = router;

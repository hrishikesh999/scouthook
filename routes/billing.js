'use strict';

const express = require('express');
const { Environment } = require('@paddle/paddle-node-sdk');
const router = express.Router();
const { sendEmailToUser } = require('../emails');
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
    // priceIdMonthly returns the *currently active* tier price ID (29/39/49)
    priceIdMonthly:  tierInfo.priceId,
    priceIdYearly:   process.env.PADDLE_PRICE_ID_YEARLY || '',
    priceIdFounding1: process.env.PADDLE_PRICE_ID_FOUNDING_1 || '',
    priceIdFounding2: process.env.PADDLE_PRICE_ID_FOUNDING_2 || '',
    proMonthlyPrice: tierInfo.price,
    foundingTier:    tierInfo.tier,
    spotsRemaining:  tierInfo.spotsRemaining,
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
    process.env.PADDLE_PRICE_ID_FOUNDING_1,
    process.env.PADDLE_PRICE_ID_FOUNDING_2,
    process.env.PADDLE_PRICE_ID_MONTHLY,
    process.env.PADDLE_PRICE_ID_YEARLY,
  ].filter(Boolean);

  try {
    const row = await db.prepare(
      'SELECT paddle_customer_id, paddle_subscription_id, current_period_end, updated_at FROM user_subscriptions WHERE user_id = ?'
    ).get(userId);

    if (row?.paddle_subscription_id) {
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

            // Send payment-failed email once per billing cycle when status becomes past_due.
            if (subscription.status === 'past_due') {
              const dedupKey = `past_due:${subscription.currentBillingPeriod?.endsAt || 'unknown'}`;
              const portalUrl = process.env.PADDLE_CUSTOMER_PORTAL_URL || (process.env.APP_URL ? `${process.env.APP_URL}/billing.html` : '');
              sendEmailToUser(userId, 'default', 'payment-failed', { portal_url: portalUrl },
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
            const plan    = !priceId ? 'pro' : (proPriceIds.includes(priceId) ? 'pro' : 'free');
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
          console.warn('[billing] subscription recovery from Paddle failed (non-fatal):', recoverErr.message);
        }
      }
    }
  } catch (checkErr) {
    console.warn('[billing] subscription stale-check failed (non-fatal):', checkErr.message);
  }

  const [sub, genCheck, visualCheck, vaultCheck] = await Promise.all([
    getUserSubscription(userId),
    canGeneratePost(userId),
    canGenerateVisual(userId),
    canUploadVaultDoc(userId),
  ]);

  return res.json({
    ok: true,
    plan: sub.plan,
    status: sub.status,
    price_id: sub.price_id ?? null,
    current_period_end: sub.current_period_end ?? null,
    canceled_at: sub.canceled_at ?? null,
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

  if (!sub.paddle_subscription_id) {
    return res.status(400).json({ ok: false, error: 'no_active_subscription' });
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
      canceledAt:           new Date(),
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
  sendEmailToUser(userId, 'default', 'cancelled', {
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
    process.env.PADDLE_PRICE_ID_FOUNDING_1,
    process.env.PADDLE_PRICE_ID_FOUNDING_2,
    process.env.PADDLE_PRICE_ID_MONTHLY,
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

  const priceId = subscription.items?.[0]?.price?.id ?? null;
  // Mirror the webhook's safe default: if priceId is absent from the REST payload
  // or not yet in our env list, keep the user on 'pro' rather than downgrading them.
  let plan;
  if (!priceId) {
    plan = 'pro'; // unknown price ID — assume pro, webhook will correct if wrong
  } else {
    plan = proPriceIds.includes(priceId) ? 'pro' : 'free';
  }

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

  console.log(`[billing] sync userId=${userId} plan=${plan} status=${subscription.status}`);

  // Send pro-activated email when a new pro subscription is created.
  // Deduplicate by subscription ID so we only send once per activation.
  if (plan === 'pro' && ['active', 'trialing'].includes(subscription.status)) {
    const renewsOn = subscription.currentBillingPeriod?.endsAt
      ? new Date(subscription.currentBillingPeriod.endsAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : '';
    sendEmailToUser(userId, 'default', 'pro-activated', {
      renews_on: renewsOn,
      app_url: process.env.APP_URL || '',
    }, { dedupKey: `pro-activated:${subscription.id}`, withinHours: 365 * 24 });
  }

  return res.json({ ok: true, plan, status: subscription.status });
});

module.exports = router;

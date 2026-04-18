'use strict';

const express = require('express');
const router = express.Router();
const {
  getPaddle,
  getUserSubscription,
  getPaddleCustomerId,
  getFoundingTierInfo,
  canGeneratePost,
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
  return res.json({
    ok: true,
    clientToken:    process.env.PADDLE_CLIENT_TOKEN || '',
    env:            process.env.NODE_ENV === 'production' ? 'production' : 'sandbox',
    // priceIdMonthly returns the *currently active* tier price ID (29/39/49)
    priceIdMonthly: tierInfo.priceId,
    priceIdYearly:  process.env.PADDLE_PRICE_ID_YEARLY || '',
    proMonthlyPrice: tierInfo.price,
    foundingTier:    tierInfo.tier,
    spotsRemaining:  tierInfo.spotsRemaining,
  });
});

// ---------------------------------------------------------------------------
// GET /api/billing/subscription
// Returns plan, status, period end, and current usage vs limits.
// ---------------------------------------------------------------------------
router.get('/subscription', requireAuth, async (req, res) => {
  const userId = req.userId;
  const [sub, genCheck, vaultCheck] = await Promise.all([
    getUserSubscription(userId),
    canGeneratePost(userId),
    canUploadVaultDoc(userId),
  ]);

  return res.json({
    ok: true,
    plan: sub.plan,
    status: sub.status,
    current_period_end: sub.current_period_end ?? null,
    canceled_at: sub.canceled_at ?? null,
    generations: {
      current: genCheck.current,
      limit: genCheck.limit === Infinity ? null : genCheck.limit,
    },
    vault_docs: {
      current: vaultCheck.current,
      limit: vaultCheck.limit === Infinity ? null : vaultCheck.limit,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/billing/checkout
// Body: { priceId: string }
// Creates a Paddle transaction and returns the hosted checkout URL.
// ---------------------------------------------------------------------------
router.post('/checkout', requireAuth, async (req, res) => {
  const userId = req.userId;
  const { priceId } = req.body || {};

  // Validate priceId is one of the configured Pro prices (prevents price injection)
  const allowedPriceIds = [
    process.env.PADDLE_PRICE_ID_FOUNDING_1,
    process.env.PADDLE_PRICE_ID_FOUNDING_2,
    process.env.PADDLE_PRICE_ID_MONTHLY,
    process.env.PADDLE_PRICE_ID_YEARLY,
  ].filter(Boolean);

  if (!priceId || !allowedPriceIds.includes(priceId)) {
    return res.status(400).json({ ok: false, error: 'invalid_price_id' });
  }

  const paddle = getPaddle();

  // Look up any existing Paddle customer ID for this user
  const existingCustomerId = await getPaddleCustomerId(userId);

  const txBody = {
    items: [{ priceId, quantity: 1 }],
    customData: { userId },
    checkout: {
      url: `${process.env.APP_URL || ''}/pricing.html?checkout=success`,
    },
  };

  // Attach customer email / existing customer ID so Paddle pre-fills the checkout
  if (existingCustomerId) {
    txBody.customer = { id: existingCustomerId };
  } else if (req.user?.email) {
    txBody.customer = { email: req.user.email };
  }

  let transaction;
  try {
    transaction = await paddle.transactions.create(txBody);
  } catch (err) {
    console.error('[billing] paddle.transactions.create error:', err.message);
    return res.status(502).json({ ok: false, error: 'paddle_error', detail: err.message });
  }

  const checkoutUrl = transaction.checkout?.url;
  if (!checkoutUrl) {
    console.error('[billing] no checkout URL in transaction:', JSON.stringify(transaction));
    return res.status(502).json({ ok: false, error: 'no_checkout_url' });
  }

  return res.json({ ok: true, checkoutUrl });
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

  try {
    await paddle.subscriptions.cancel(sub.paddle_subscription_id, {
      effectiveFrom: 'next_billing_period',
    });
  } catch (err) {
    console.error('[billing] paddle.subscriptions.cancel error:', err.message);
    return res.status(502).json({ ok: false, error: 'paddle_error', detail: err.message });
  }

  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/billing/portal
// Returns a Paddle customer portal URL for managing payment methods / invoices.
// ---------------------------------------------------------------------------
router.get('/portal', requireAuth, async (req, res) => {
  const userId = req.userId;
  const customerId = await getPaddleCustomerId(userId);

  if (!customerId) {
    return res.status(400).json({ ok: false, error: 'no_paddle_customer' });
  }

  const paddle = getPaddle();

  let portal;
  try {
    portal = await paddle.customers.createPortalSession(customerId, {
      subscriptionIds: [],
    });
  } catch (err) {
    console.error('[billing] paddle.customers.createPortalSession error:', err.message);
    return res.status(502).json({ ok: false, error: 'paddle_error', detail: err.message });
  }

  return res.json({ ok: true, portalUrl: portal.urls?.general?.overview ?? portal.url });
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
      // subscriptionId can be absent on the first GET right after checkout — brief poll.
      let transaction = null;
      const maxAttempts = 12;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        transaction = await paddle.transactions.get(transactionId);

        // Security: verify this transaction belongs to the authenticated user when present.
        // Set on POST /checkout transactions and Paddle.Checkout.open customData (overlay).
        const txUserId = getTransactionCustomUserId(transaction);
        if (txUserId && txUserId !== userId) {
          console.warn(`[billing] sync userId mismatch: req=${userId} tx=${txUserId}`);
          return res.status(403).json({ ok: false, error: 'transaction_not_owned' });
        }

        if (transaction?.subscriptionId) break;
        if (attempt < maxAttempts - 1) await delay(450);
      }

      if (transaction?.subscriptionId) {
        subscription = await paddle.subscriptions.get(transaction.subscriptionId);
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
  return res.json({ ok: true, plan, status: subscription.status });
});

module.exports = router;

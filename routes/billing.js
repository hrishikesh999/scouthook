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
} = require('../services/subscription');

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

module.exports = router;

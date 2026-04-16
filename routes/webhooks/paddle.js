'use strict';

/**
 * routes/webhooks/paddle.js
 *
 * Paddle webhook endpoint.
 *
 * IMPORTANT: This route MUST be mounted in server.js BEFORE express.json() so
 * that the raw request body (Buffer) is preserved for Paddle signature verification.
 * The route mounts its own express.raw() body parser.
 *
 * Handles:
 *   subscription.created   → create / update subscription row
 *   subscription.updated   → update plan, status, billing dates
 *   subscription.canceled  → mark canceled; user retains Pro access until period end
 *   transaction.completed  → safety net (no-op when subscription events are present)
 */

const express = require('express');
const router = express.Router();
const { Paddle, Environment } = require('@paddle/paddle-node-sdk');
const { upsertSubscription } = require('../../services/subscription');

// Raw body parser — required so we can verify Paddle's HMAC signature.
// This overrides the global express.json() for this route only.
router.use(express.raw({ type: 'application/json' }));

router.post('/', async (req, res) => {
  const signature = req.headers['paddle-signature'];
  if (!signature) {
    return res.status(400).json({ ok: false, error: 'missing_signature' });
  }

  const webhookSecret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[paddle-webhook] PADDLE_WEBHOOK_SECRET is not configured');
    return res.status(500).end();
  }

  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) {
    console.error('[paddle-webhook] PADDLE_API_KEY is not configured');
    return res.status(500).end();
  }

  let event;
  try {
    const paddle = new Paddle(apiKey, {
      environment: process.env.NODE_ENV === 'production'
        ? Environment.production
        : Environment.sandbox,
    });
    // req.body is a Buffer here (express.raw)
    event = paddle.webhooks.unmarshal(req.body.toString(), webhookSecret, signature);
  } catch (err) {
    console.warn('[paddle-webhook] signature verification failed:', err.message);
    return res.status(401).json({ ok: false, error: 'invalid_signature' });
  }

  try {
    await handlePaddleEvent(event);
  } catch (err) {
    // Return 200 so Paddle does not retry indefinitely for logic errors.
    // Verification failures (above) are the only case for non-2xx.
    console.error('[paddle-webhook] handler error for', event?.eventType, ':', err.message);
  }

  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Allowed Pro price IDs (resolved from env at runtime)
// ---------------------------------------------------------------------------
function getProPriceIds() {
  return [
    process.env.PADDLE_PRICE_ID_MONTHLY,
    process.env.PADDLE_PRICE_ID_YEARLY,
  ].filter(Boolean);
}

function planFromPriceId(priceId) {
  return getProPriceIds().includes(priceId) ? 'pro' : 'free';
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------
async function handlePaddleEvent(event) {
  const { eventType, data } = event;

  const userId = data?.customData?.userId ?? null;

  if (eventType === 'subscription.created' || eventType === 'subscription.updated') {
    if (!userId) {
      console.warn(`[paddle-webhook] ${eventType}: no userId in customData — skipping`);
      return;
    }

    const priceId = data.items?.[0]?.price?.id ?? null;
    const plan    = planFromPriceId(priceId);

    await upsertSubscription({
      userId,
      paddleCustomerId:      data.customerId,
      paddleSubscriptionId:  data.id,
      plan,
      status:                data.status,
      currentPeriodEnd:      data.currentBillingPeriod?.endsAt
                               ? new Date(data.currentBillingPeriod.endsAt)
                               : null,
      canceledAt:            data.canceledAt ? new Date(data.canceledAt) : null,
    });

    console.log(`[paddle-webhook] ${eventType} userId=${userId} plan=${plan} status=${data.status}`);
    return;
  }

  if (eventType === 'subscription.canceled') {
    if (!userId) {
      console.warn('[paddle-webhook] subscription.canceled: no userId in customData — skipping');
      return;
    }

    // Keep plan='pro' so the user retains access until current_period_end.
    // getUserPlan() will return 'free' once the period passes.
    await upsertSubscription({
      userId,
      paddleCustomerId:      data.customerId,
      paddleSubscriptionId:  data.id,
      plan:                  'pro',
      status:                'canceled',
      currentPeriodEnd:      data.currentBillingPeriod?.endsAt
                               ? new Date(data.currentBillingPeriod.endsAt)
                               : null,
      canceledAt:            new Date(),
    });

    console.log(`[paddle-webhook] subscription.canceled userId=${userId}`);
    return;
  }

  if (eventType === 'transaction.completed') {
    // subscription.created / subscription.updated are the source of truth for
    // provisioning.  This handler is a safety net for edge cases (e.g. event
    // ordering issues). Skip if the transaction has an associated subscription.
    if (data.subscriptionId) return;
    if (userId) {
      console.log(`[paddle-webhook] transaction.completed userId=${userId} (no subscription)`);
    }
    return;
  }

  // All other event types are silently acknowledged.
}

module.exports = router;

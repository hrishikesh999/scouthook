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
 *   subscription.* (created, updated, activated, trialing, resumed, past_due) → upsert row
 *   subscription.canceled  → mark canceled; user retains Pro access until period end
 *   transaction.completed  → when subscription_id is set, fetch subscription and upsert
 *                              (backup if client-side sync / other events miss)
 */

const express = require('express');
const router = express.Router();
const { db } = require('../../db');
const { upsertSubscription, getPaddle } = require('../../services/subscription');

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
    const paddle = getPaddle();
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
// Includes all founding tier price IDs in addition to regular monthly/yearly.
// ---------------------------------------------------------------------------
function getProPriceIds() {
  return [
    process.env.PADDLE_PRICE_ID_FOUNDING_1,
    process.env.PADDLE_PRICE_ID_FOUNDING_2,
    process.env.PADDLE_PRICE_ID_MONTHLY,
    process.env.PADDLE_PRICE_ID_YEARLY,
  ].filter(Boolean);
}

function planFromPriceId(priceId) {
  return getProPriceIds().includes(priceId) ? 'pro' : 'free';
}

function customDataUserId(customData) {
  if (!customData || typeof customData !== 'object') return null;
  const v = customData.userId ?? customData.user_id;
  return typeof v === 'string' && v.length ? v : null;
}

async function resolveUserIdForSubscriptionPayload(data) {
  let userId = customDataUserId(data?.customData);
  if (!userId) {
    try {
      if (data?.customerId || data?.id) {
        const row = await db.prepare(`
            SELECT user_id
            FROM user_subscriptions
            WHERE paddle_subscription_id = ? OR paddle_customer_id = ?
            LIMIT 1
          `).get(data?.id ?? null, data?.customerId ?? null);
        userId = row?.user_id ?? null;
      }
    } catch (e) {
      console.warn(`[paddle-webhook] subscription user lookup failed: ${e.message}`);
    }
  }
  return userId;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------
async function handlePaddleEvent(event) {
  const { eventType, data } = event;

  const subscriptionUpsertEvents = new Set([
    'subscription.created',
    'subscription.updated',
    'subscription.activated',
    'subscription.trialing',
    'subscription.resumed',
    'subscription.past_due',
  ]);

  if (subscriptionUpsertEvents.has(eventType)) {
    const userId = await resolveUserIdForSubscriptionPayload(data);
    if (!userId) {
      console.warn(`[paddle-webhook] ${eventType}: no userId in custom_data (and DB fallback failed) — skipping`);
      return;
    }

    const priceId = data.items?.[0]?.price?.id ?? null;
    const plan    = priceId ? planFromPriceId(priceId) : 'pro';

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
      priceId:               priceId ?? null,
    });

    console.log(`[paddle-webhook] ${eventType} userId=${userId} plan=${plan} status=${data.status} priceId=${priceId ?? 'unknown'}`);
    return;
  }

  if (eventType === 'subscription.canceled') {
    const userId = await resolveUserIdForSubscriptionPayload(data);

    if (!userId) {
      console.warn('[paddle-webhook] subscription.canceled: no userId in custom_data (and fallback failed) — skipping');
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
    const subId = data?.subscriptionId ?? data?.subscription_id ?? null;
    if (!subId) return;

    let userId = customDataUserId(data?.customData);
    if (!userId && data?.customerId) {
      try {
        const row = await db.prepare(`
          SELECT user_id FROM user_subscriptions WHERE paddle_customer_id = ? LIMIT 1
        `).get(data.customerId);
        userId = row?.user_id ?? null;
      } catch (e) {
        console.warn(`[paddle-webhook] transaction.completed customer lookup failed: ${e.message}`);
      }
    }

    if (!userId) {
      console.warn('[paddle-webhook] transaction.completed: no userId in custom_data — skipping (subscription.* should still provision)');
      return;
    }

    const paddle = getPaddle();
    let subscription;
    try {
      subscription = await paddle.subscriptions.get(subId);
    } catch (e) {
      console.error('[paddle-webhook] transaction.completed: subscriptions.get failed:', e.message);
      return;
    }

    const priceId = subscription.items?.[0]?.price?.id ?? null;
    const plan    = priceId ? planFromPriceId(priceId) : 'pro';

    await upsertSubscription({
      userId,
      paddleCustomerId:     subscription.customerId ?? data.customerId,
      paddleSubscriptionId: subscription.id,
      plan,
      status:               subscription.status,
      currentPeriodEnd:     subscription.currentBillingPeriod?.endsAt
                              ? new Date(subscription.currentBillingPeriod.endsAt)
                              : null,
      canceledAt:           subscription.canceledAt ? new Date(subscription.canceledAt) : null,
      priceId:              priceId ?? null,
    });

    console.log(`[paddle-webhook] transaction.completed provisioned userId=${userId} sub=${subId}`);
    return;
  }

  // All other event types are silently acknowledged.
}

module.exports = router;

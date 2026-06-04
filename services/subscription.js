'use strict';

const { db } = require('../db');
const { Paddle, Environment } = require('@paddle/paddle-node-sdk');
const { getMonthlyPostLimit } = require('../lib/planFeatures');

// ---------------------------------------------------------------------------
// Paddle SDK singleton
// ---------------------------------------------------------------------------
let _paddle;

/** Prefer PADDLE_ENVIRONMENT=sandbox|production when NODE_ENV does not match your Paddle account (common on staging). */
function getPaddleEnvironment() {
  const explicit = (process.env.PADDLE_ENVIRONMENT || process.env.PADDLE_ENV || '').toLowerCase();
  if (explicit === 'sandbox') return Environment.sandbox;
  if (explicit === 'production') return Environment.production;
  return process.env.NODE_ENV === 'production'
    ? Environment.production
    : Environment.sandbox;
}

function getPaddle() {
  if (!_paddle) {
    const apiKey = process.env.PADDLE_API_KEY;
    if (!apiKey) throw new Error('PADDLE_API_KEY is not configured');
    _paddle = new Paddle(apiKey, {
      environment: getPaddleEnvironment(),
    });
  }
  return _paddle;
}

// ---------------------------------------------------------------------------
// getUserSubscription
// Returns the user_subscriptions row, or a synthetic free object if none exists.
// ---------------------------------------------------------------------------
async function getUserSubscription(userId) {
  try {
    const row = await db.prepare(
      'SELECT * FROM user_subscriptions WHERE user_id = ?'
    ).get(userId);
    if (row) return row;
  } catch (err) {
    console.error('[subscription] getUserSubscription error:', err.message);
  }
  // Synthetic free row — user has never subscribed
  return {
    user_id: userId,
    paddle_customer_id: null,
    paddle_subscription_id: null,
    plan: 'free',
    status: 'free',
    current_period_end: null,
    canceled_at: null,
  };
}

// ---------------------------------------------------------------------------
// getUserPlan
// Returns 'free' | 'solo' | 'pro'.
// A canceled subscription retains access until current_period_end.
// ---------------------------------------------------------------------------
async function getUserPlan(userId) {
  const sub = await getUserSubscription(userId);
  // Normalise to the three known tiers; unknown values fall back to free.
  const tier = ['free', 'solo', 'pro'].includes(sub.plan) ? sub.plan : 'free';
  if (tier === 'free') return 'free';
  if (!['active', 'trialing', 'canceled', 'past_due', 'paused'].includes(sub.status)) return 'free';
  if (sub.status === 'canceled') {
    if (!sub.current_period_end) return 'free';
    if (new Date(sub.current_period_end) <= new Date()) return 'free';
  }

  // Founding members bought at the $29/mo founding price → Solo features.
  // They keep their price but are mapped to the Solo tier for feature gating.
  // They can upgrade to Pro ($39/mo) for unlimited posts + company pages + teams.
  if (tier === 'pro' && sub.price_id) {
    const foundingIds = [
      process.env.PADDLE_PRICE_ID_FOUNDING_1,
      process.env.PADDLE_PRICE_ID_FOUNDING_2,
    ].filter(Boolean);
    if (foundingIds.includes(sub.price_id)) return 'solo';
  }

  return tier; // 'solo' | 'pro'
}

// ---------------------------------------------------------------------------
// getFoundingTierInfo
// Returns the standard Pro price ($39/month) for all new subscribers.
// Falls back to FOUNDING_2 price ID only if FOUNDING_1 is not configured.
// ---------------------------------------------------------------------------
async function getFoundingTierInfo() {
  const priceId = process.env.PADDLE_PRICE_ID_FOUNDING_1 || process.env.PADDLE_PRICE_ID_FOUNDING_2;
  return {
    priceId,
    price: 39,
    tier: 'founding_1',
    spotsRemaining: 0,
  };
}

// ---------------------------------------------------------------------------
// calendarMonthBounds
// Returns [start, end) ISO strings for the current UTC calendar month.
// ---------------------------------------------------------------------------
function calendarMonthBounds() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return [start.toISOString(), end.toISOString()];
}

// ---------------------------------------------------------------------------
// canGeneratePost
// Counts quality-gate-passing posts this calendar month, per user (across all
// workspaces — user-governs model). Returns { allowed, current, limit, plan, resets_at }.
// Only rows with passed_gate = 1 count toward the limit.
// ---------------------------------------------------------------------------
async function canGeneratePost(userId) {
  const plan = await getUserPlan(userId);
  const rawLimit = getMonthlyPostLimit(plan); // 5 | 20 | Infinity
  const limit = rawLimit === Infinity ? null : rawLimit;
  const [start, end] = calendarMonthBounds();

  let current = 0;
  try {
    const row = await db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM generated_posts
      WHERE user_id = ?
        AND passed_gate = 1
        AND created_at >= ?
        AND created_at < ?
    `).get(userId, start, end);
    current = parseInt(row?.cnt ?? 0, 10);
  } catch (err) {
    console.error('[subscription] canGeneratePost count error:', err.message);
    // On DB error, allow generation rather than silently blocking the user
    return { allowed: true, current: 0, limit, plan, resets_at: end };
  }

  return { allowed: limit === null || current < limit, current, limit, plan, resets_at: end };
}

// ---------------------------------------------------------------------------
// canGenerateVisual
// Pro users: allowed if visual generations this month < PRO_VISUAL_LIMIT.
// Free users: allowed only in their first calendar month (account creation month),
//             up to FREE_VISUAL_LIMIT generations.
// ---------------------------------------------------------------------------
async function canGenerateVisual(userId, tenantId = 'default') {
  const plan  = await getUserPlan(userId);
  // Visuals: same monthly quota as text generation (user-governs model).
  const rawLimit = getMonthlyPostLimit(plan);
  const limit = rawLimit === Infinity ? null : rawLimit;
  const [start, end] = calendarMonthBounds();

  let current = 0;
  try {
    const row = await db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM visual_generation_log
      WHERE user_id = ?
        AND created_at >= ?
        AND created_at < ?
    `).get(userId, start, end);
    current = parseInt(row?.cnt ?? 0, 10);
  } catch (err) {
    console.error('[subscription] canGenerateVisual count error:', err.message);
    return { allowed: true, current: 0, limit, plan };
  }
  return { allowed: limit === null || current < limit, current, limit, plan };
}

// ---------------------------------------------------------------------------
// logVisualGeneration
// Records a visual generation event for limit tracking.
// ---------------------------------------------------------------------------
async function logVisualGeneration(userId, tenantId = 'default', postId, visualType) {
  try {
    await db.prepare(`
      INSERT INTO visual_generation_log (user_id, tenant_id, post_id, visual_type)
      VALUES (?, ?, ?, ?)
    `).run(userId, tenantId, postId ?? null, visualType);
  } catch (err) {
    console.error('[subscription] logVisualGeneration error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// canUploadVaultDoc — unrestricted for all plans.
async function canUploadVaultDoc(_userId) {
  return { allowed: true, current: 0, limit: null, plan: null };
}

// ---------------------------------------------------------------------------
// getPaddleCustomerId
// ---------------------------------------------------------------------------
async function getPaddleCustomerId(userId) {
  const row = await db.prepare(
    'SELECT paddle_customer_id FROM user_subscriptions WHERE user_id = ?'
  ).get(userId);
  return row?.paddle_customer_id ?? null;
}

// ---------------------------------------------------------------------------
// upsertSubscription
// Creates or updates the subscription row from webhook data.
// ---------------------------------------------------------------------------
async function upsertSubscription({
  userId,
  paddleCustomerId,
  paddleSubscriptionId,
  plan,
  status,
  currentPeriodEnd,
  canceledAt,
  priceId,
}) {
  await db.prepare(`
    INSERT INTO user_subscriptions
      (user_id, paddle_customer_id, paddle_subscription_id, plan, status,
       current_period_end, canceled_at, price_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, now())
    ON CONFLICT (user_id) DO UPDATE SET
      paddle_customer_id     = COALESCE(excluded.paddle_customer_id,     user_subscriptions.paddle_customer_id),
      paddle_subscription_id = COALESCE(excluded.paddle_subscription_id, user_subscriptions.paddle_subscription_id),
      plan                   = excluded.plan,
      status                 = excluded.status,
      -- Paddle webhook payloads sometimes omit currentBillingPeriod.endsAt
      -- on subscription.updated. Preserve the existing value so we don't
      -- revoke Pro access early.
      current_period_end     = COALESCE(excluded.current_period_end, user_subscriptions.current_period_end),
      canceled_at            = excluded.canceled_at,
      price_id               = COALESCE(excluded.price_id, user_subscriptions.price_id),
      updated_at             = now()
  `).run(
    userId,
    paddleCustomerId ?? null,
    paddleSubscriptionId ?? null,
    plan,
    status,
    currentPeriodEnd ?? null,
    canceledAt ?? null,
    priceId ?? null,
  );
}

// ---------------------------------------------------------------------------
// forceSyncSubscriptionForUser
// Fetches the latest subscription state from Paddle and writes it to DB.
// Used by the daily cron that re-syncs stale/expired subscriptions.
// Returns { plan, status } of the synced subscription, or null if not found.
// ---------------------------------------------------------------------------
const FORCE_SYNC_PRO_PRICE_IDS = [
  process.env.PADDLE_PRICE_ID_FOUNDING_1,
  process.env.PADDLE_PRICE_ID_FOUNDING_2,
  process.env.PADDLE_PRICE_ID_YEARLY,
].filter(Boolean);

async function forceSyncSubscriptionForUser(userId) {
  const row = await db.prepare(
    'SELECT paddle_subscription_id, paddle_customer_id FROM user_subscriptions WHERE user_id = ?'
  ).get(userId);

  let subscription = null;
  const paddle = getPaddle();

  if (row?.paddle_subscription_id) {
    subscription = await paddle.subscriptions.get(row.paddle_subscription_id);
  } else if (row?.paddle_customer_id) {
    const result = await paddle.subscriptions.list({ customerId: [row.paddle_customer_id] });
    const subs = result?.data ?? [];
    subscription = subs.find(s => ['active', 'trialing'].includes(s.status)) ?? subs[0] ?? null;
  }

  if (!subscription) return null;

  const priceId = subscription.items?.[0]?.price?.id ?? null;
  const plan    = !priceId || FORCE_SYNC_PRO_PRICE_IDS.includes(priceId) ? 'pro' : 'free';

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

  return { plan, status: subscription.status };
}

module.exports = {
  getPaddle,
  getPaddleEnvironment,
  getUserSubscription,
  getUserPlan,
  getFoundingTierInfo,
  canGeneratePost,
  canGenerateVisual,
  logVisualGeneration,
  canUploadVaultDoc,
  getPaddleCustomerId,
  upsertSubscription,
  forceSyncSubscriptionForUser,
};

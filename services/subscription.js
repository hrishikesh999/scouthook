'use strict';

const { db } = require('../db');
const { Paddle, Environment } = require('@paddle/paddle-node-sdk');
const { getMonthlyPostLimit } = require('../lib/planFeatures');

// Internal hard caps — never shown to users; exist to prevent runaway abuse.
// Env vars allow tuning without a deploy. Values are per user per calendar month.
const INTERNAL_POST_CAP_FREE   = parseInt(process.env.INTERNAL_POST_CAP_FREE   || '25',  10);
const INTERNAL_POST_CAP_PRO    = parseInt(process.env.INTERNAL_POST_CAP_PRO    || '500', 10);
const INTERNAL_VISUAL_CAP_FREE = parseInt(process.env.INTERNAL_VISUAL_CAP_FREE || '25',  10);
const INTERNAL_VISUAL_CAP_PRO  = parseInt(process.env.INTERNAL_VISUAL_CAP_PRO  || '800', 10);

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
  // past_due: allow access during Paddle's retry window (~7–10 days), then lapse.
  if (sub.status === 'past_due' && sub.current_period_end) {
    const GRACE_MS = 14 * 24 * 60 * 60 * 1000;
    if (new Date(sub.current_period_end).getTime() + GRACE_MS < Date.now()) return 'free';
  }
  // App-level trial: enforce expiry via trial_ends_at (no Paddle subscription involved).
  if (sub.status === 'trialing' && sub.trial_ends_at && new Date(sub.trial_ends_at) <= new Date()) {
    return 'free';
  }


  return tier; // 'solo' | 'pro'
}

// ---------------------------------------------------------------------------
// getFoundingTierInfo
// Returns the Pro price ID from PADDLE_PRICE_ID_PRO.
// ---------------------------------------------------------------------------
async function getFoundingTierInfo() {
  const priceId = process.env.PADDLE_PRICE_ID_PRO;
  return {
    priceId,
    price: 29,
    tier: 'pro',
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

  const internalCap = plan === 'pro' ? INTERNAL_POST_CAP_PRO : INTERNAL_POST_CAP_FREE;
  const allowedByQuota = limit === null || current < limit;
  const allowedByCap   = current < internalCap;
  return { allowed: allowedByQuota && allowedByCap, current, limit, plan, resets_at: end };
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
  const internalCap = plan === 'pro' ? INTERNAL_VISUAL_CAP_PRO : INTERNAL_VISUAL_CAP_FREE;
  const allowedByQuota = limit === null || current < limit;
  const allowedByCap   = current < internalCap;
  return { allowed: allowedByQuota && allowedByCap, current, limit, plan };
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
  process.env.PADDLE_PRICE_ID_PRO,
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
  // If price ID list is empty (env vars missing), default to 'pro' to avoid silently downgrading users.
  const plan    = (FORCE_SYNC_PRO_PRICE_IDS.length === 0 || !priceId || FORCE_SYNC_PRO_PRICE_IDS.includes(priceId))
    ? 'pro'
    : 'free';

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

// ---------------------------------------------------------------------------
// seedTrialSubscription
// Called on new-user signup. Inserts a 7-day Pro trial row.
// ON CONFLICT DO NOTHING ensures it never overwrites an existing subscription.
// ---------------------------------------------------------------------------
async function seedTrialSubscription(userId) {
  const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  try {
    await db.prepare(`
      INSERT INTO user_subscriptions (user_id, plan, status, trial_ends_at)
      VALUES (?, 'pro', 'trialing', ?)
      ON CONFLICT (user_id) DO NOTHING
    `).run(userId, trialEnd.toISOString());
  } catch (err) {
    console.error('[subscription] seedTrialSubscription error (non-fatal):', err.message);
  }
}

module.exports = {
  getPaddle,
  getPaddleEnvironment,
  getUserSubscription,
  getUserPlan,
  getFoundingTierInfo,
  seedTrialSubscription,
  canGeneratePost,
  canGenerateVisual,
  logVisualGeneration,
  canUploadVaultDoc,
  getPaddleCustomerId,
  upsertSubscription,
  forceSyncSubscriptionForUser,
  INTERNAL_POST_CAP_FREE,
  INTERNAL_POST_CAP_PRO,
  INTERNAL_VISUAL_CAP_FREE,
  INTERNAL_VISUAL_CAP_PRO,
};

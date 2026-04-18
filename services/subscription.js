'use strict';

const { db } = require('../db');
const { Paddle, Environment } = require('@paddle/paddle-node-sdk');

// ---------------------------------------------------------------------------
// Plan limits
// ---------------------------------------------------------------------------
const FREE_GENERATION_LIMIT  = 3;   // quality-gate passes per calendar month
const FREE_VISUAL_LIMIT      = 3;   // visuals in first calendar month of account only
const FREE_VAULT_DOC_LIMIT   = 1;   // total documents
const PRO_GENERATION_LIMIT   = 40;  // quality-gate passes per calendar month
const PRO_VISUAL_LIMIT       = 20;  // visuals per calendar month
const PRO_VAULT_DOC_LIMIT    = 10;  // vault documents per calendar month

// ---------------------------------------------------------------------------
// Founding tier configuration
// Spots:  0–9   → Tier 1 ($29, env: PADDLE_PRICE_ID_FOUNDING_1)
//         10–49 → Tier 2 ($39, env: PADDLE_PRICE_ID_FOUNDING_2)
//         50+   → Regular ($49, env: PADDLE_PRICE_ID_MONTHLY)
// ---------------------------------------------------------------------------
const FOUNDING_1_MAX = 10;
const FOUNDING_2_MAX = 50;

// ---------------------------------------------------------------------------
// Paddle SDK singleton
// ---------------------------------------------------------------------------
let _paddle;
function getPaddle() {
  if (!_paddle) {
    const apiKey = process.env.PADDLE_API_KEY;
    if (!apiKey) throw new Error('PADDLE_API_KEY is not configured');
    _paddle = new Paddle(apiKey, {
      environment: process.env.NODE_ENV === 'production'
        ? Environment.production
        : Environment.sandbox,
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
// Returns 'pro' if the user has an active/trialing Pro subscription whose
// period has not yet ended; otherwise 'free'.
// A canceled subscription retains Pro access until current_period_end.
// ---------------------------------------------------------------------------
async function getUserPlan(userId) {
  const sub = await getUserSubscription(userId);
  if (sub.plan !== 'pro') return 'free';
  // Treat these statuses as "still Pro". Only `canceled` needs a grace check.
  if (!['active', 'trialing', 'canceled', 'past_due', 'paused'].includes(sub.status)) return 'free';
  // For canceled subs, check the grace period
  if (sub.status === 'canceled') {
    if (!sub.current_period_end) return 'free';
    if (new Date(sub.current_period_end) <= new Date()) return 'free';
  }
  return 'pro';
}

// ---------------------------------------------------------------------------
// getFoundingTierInfo
// Counts active pro subscribers to determine which pricing tier is currently
// available. Gracefully skips a tier if its env var is not configured.
// Returns { priceId, price, tier, spotsRemaining }.
// ---------------------------------------------------------------------------
async function getFoundingTierInfo() {
  let count = 0;
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS cnt FROM user_subscriptions WHERE plan = 'pro' AND status IN ('active', 'trialing', 'past_due', 'paused')`
    ).get();
    count = parseInt(row?.cnt ?? 0, 10);
  } catch (err) {
    console.error('[subscription] getFoundingTierInfo count error:', err.message);
  }

  const f1PriceId = process.env.PADDLE_PRICE_ID_FOUNDING_1;
  const f2PriceId = process.env.PADDLE_PRICE_ID_FOUNDING_2;
  const regularPriceId = process.env.PADDLE_PRICE_ID_MONTHLY || '';

  if (count < FOUNDING_1_MAX && f1PriceId) {
    return {
      priceId: f1PriceId,
      price: 29,
      tier: 'founding_1',
      spotsRemaining: FOUNDING_1_MAX - count,
    };
  }
  if (count < FOUNDING_2_MAX && f2PriceId) {
    return {
      priceId: f2PriceId,
      price: 39,
      tier: 'founding_2',
      spotsRemaining: FOUNDING_2_MAX - count,
    };
  }
  return {
    priceId: regularPriceId,
    price: 49,
    tier: 'regular',
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
// Pro users: allowed if quality-gate passes this month < PRO_GENERATION_LIMIT.
// Free users: allowed if quality-gate passes this month < FREE_GENERATION_LIMIT.
// Only rows with passed_gate = 1 count toward the limit.
// ---------------------------------------------------------------------------
async function canGeneratePost(userId) {
  const plan = await getUserPlan(userId);
  const limit = plan === 'pro' ? PRO_GENERATION_LIMIT : FREE_GENERATION_LIMIT;
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
    return { allowed: true, current: 0, limit, plan };
  }

  return { allowed: current < limit, current, limit, plan };
}

// ---------------------------------------------------------------------------
// canGenerateVisual
// Pro users: allowed if visual generations this month < PRO_VISUAL_LIMIT.
// Free users: allowed only in their first calendar month (account creation month),
//             up to FREE_VISUAL_LIMIT generations.
// ---------------------------------------------------------------------------
async function canGenerateVisual(userId, tenantId = 'default') {
  const plan = await getUserPlan(userId);
  const [start, end] = calendarMonthBounds();

  if (plan === 'pro') {
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
      console.error('[subscription] canGenerateVisual pro count error:', err.message);
      return { allowed: true, current: 0, limit: PRO_VISUAL_LIMIT, plan };
    }
    return { allowed: current < PRO_VISUAL_LIMIT, current, limit: PRO_VISUAL_LIMIT, plan };
  }

  // Free: check if current month is the user's first calendar month
  let isFirstMonth = false;
  try {
    const profile = await db.prepare(
      'SELECT MIN(created_at) AS first_seen FROM user_profiles WHERE user_id = ?'
    ).get(userId);
    if (profile?.first_seen) {
      const firstDate = new Date(profile.first_seen);
      const now = new Date();
      isFirstMonth = (
        firstDate.getUTCFullYear() === now.getUTCFullYear() &&
        firstDate.getUTCMonth() === now.getUTCMonth()
      );
    }
  } catch (err) {
    console.error('[subscription] canGenerateVisual profile lookup error:', err.message);
  }

  if (!isFirstMonth) {
    return { allowed: false, current: 0, limit: 0, plan: 'free', reason: 'first_month_only' };
  }

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
    console.error('[subscription] canGenerateVisual free count error:', err.message);
    return { allowed: true, current: 0, limit: FREE_VISUAL_LIMIT, plan: 'free' };
  }

  return {
    allowed: current < FREE_VISUAL_LIMIT,
    current,
    limit: FREE_VISUAL_LIMIT,
    plan: 'free',
  };
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
// canUploadVaultDoc
// Pro users: allowed if vault docs this month < PRO_VAULT_DOC_LIMIT.
// Free users: allowed if total vault_documents count < FREE_VAULT_DOC_LIMIT.
// ---------------------------------------------------------------------------
async function canUploadVaultDoc(userId) {
  const plan = await getUserPlan(userId);

  if (plan === 'pro') {
    const [start, end] = calendarMonthBounds();
    let current = 0;
    try {
      const row = await db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM vault_documents
        WHERE user_id = ?
          AND created_at >= ?
          AND created_at < ?
      `).get(userId, start, end);
      current = parseInt(row?.cnt ?? 0, 10);
    } catch (err) {
      console.error('[subscription] canUploadVaultDoc pro count error:', err.message);
      return { allowed: true, current: 0, limit: PRO_VAULT_DOC_LIMIT, plan: 'pro' };
    }
    return { allowed: current < PRO_VAULT_DOC_LIMIT, current, limit: PRO_VAULT_DOC_LIMIT, plan: 'pro' };
  }

  const row = await db.prepare(
    'SELECT COUNT(*) AS cnt FROM vault_documents WHERE user_id = ?'
  ).get(userId);

  const current = parseInt(row?.cnt ?? 0, 10);
  return {
    allowed: current < FREE_VAULT_DOC_LIMIT,
    current,
    limit: FREE_VAULT_DOC_LIMIT,
    plan: 'free',
  };
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
      canceled_at            = COALESCE(excluded.canceled_at, user_subscriptions.canceled_at),
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

module.exports = {
  getPaddle,
  getUserSubscription,
  getUserPlan,
  getFoundingTierInfo,
  canGeneratePost,
  canGenerateVisual,
  logVisualGeneration,
  canUploadVaultDoc,
  getPaddleCustomerId,
  upsertSubscription,
  FREE_GENERATION_LIMIT,
  FREE_VISUAL_LIMIT,
  FREE_VAULT_DOC_LIMIT,
  PRO_GENERATION_LIMIT,
  PRO_VISUAL_LIMIT,
  PRO_VAULT_DOC_LIMIT,
};

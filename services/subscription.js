'use strict';

const { db } = require('../db');
const { Paddle, Environment } = require('@paddle/paddle-node-sdk');

// ---------------------------------------------------------------------------
// Plan limits (Free tier)
// ---------------------------------------------------------------------------
const FREE_GENERATION_LIMIT = 5;  // per calendar month
const FREE_VAULT_DOC_LIMIT  = 1;  // total documents

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
  if (!['active', 'trialing', 'canceled'].includes(sub.status)) return 'free';
  // For canceled subs, check the grace period
  if (sub.status === 'canceled') {
    if (!sub.current_period_end) return 'free';
    if (new Date(sub.current_period_end) <= new Date()) return 'free';
  }
  return 'pro';
}

// ---------------------------------------------------------------------------
// canGeneratePost
// Pro users: always allowed.
// Free users: allowed if calendar-month generation count < FREE_GENERATION_LIMIT.
// ---------------------------------------------------------------------------
async function canGeneratePost(userId) {
  const plan = await getUserPlan(userId);
  if (plan === 'pro') {
    return { allowed: true, current: 0, limit: Infinity, plan: 'pro' };
  }

  const row = await db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM generation_runs
    WHERE user_id = ?
      AND created_at >= date_trunc('month', now())
      AND created_at <  date_trunc('month', now()) + interval '1 month'
  `).get(userId);

  const current = parseInt(row?.cnt ?? 0, 10);
  return {
    allowed: current < FREE_GENERATION_LIMIT,
    current,
    limit: FREE_GENERATION_LIMIT,
    plan: 'free',
  };
}

// ---------------------------------------------------------------------------
// canUploadVaultDoc
// Pro users: always allowed.
// Free users: allowed if total vault_documents count < FREE_VAULT_DOC_LIMIT.
// ---------------------------------------------------------------------------
async function canUploadVaultDoc(userId) {
  const plan = await getUserPlan(userId);
  if (plan === 'pro') {
    return { allowed: true, current: 0, limit: Infinity, plan: 'pro' };
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
}) {
  await db.prepare(`
    INSERT INTO user_subscriptions
      (user_id, paddle_customer_id, paddle_subscription_id, plan, status,
       current_period_end, canceled_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, now())
    ON CONFLICT (user_id) DO UPDATE SET
      paddle_customer_id     = COALESCE(excluded.paddle_customer_id,     user_subscriptions.paddle_customer_id),
      paddle_subscription_id = COALESCE(excluded.paddle_subscription_id, user_subscriptions.paddle_subscription_id),
      plan                   = excluded.plan,
      status                 = excluded.status,
      current_period_end     = excluded.current_period_end,
      canceled_at            = COALESCE(excluded.canceled_at, user_subscriptions.canceled_at),
      updated_at             = now()
  `).run(
    userId,
    paddleCustomerId ?? null,
    paddleSubscriptionId ?? null,
    plan,
    status,
    currentPeriodEnd ?? null,
    canceledAt ?? null,
  );
}

module.exports = {
  getPaddle,
  getUserSubscription,
  getUserPlan,
  canGeneratePost,
  canUploadVaultDoc,
  getPaddleCustomerId,
  upsertSubscription,
  FREE_GENERATION_LIMIT,
  FREE_VAULT_DOC_LIMIT,
};

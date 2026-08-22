'use strict';

const { db } = require('../db');
const { Paddle, Environment } = require('@paddle/paddle-node-sdk');
const { getMonthlyPostLimit, isPaidPlan } = require('../lib/planFeatures');

// How many posts a free-tier account gets, for the lifetime of the account —
// there is no monthly reset below the paid plans. Four, not three, because the
// fourth post is where the upgrade ask lives: it generates normally and the ask
// arrives in the editor beneath it, rather than replacing the generation the
// user was trying to run. Per-user overrides live in
// user_subscriptions.free_posts_limit (admin grants); this is the default for a
// row that has none, and is kept in step with migration 091's column default.
const FREE_POSTS_LIMIT = 4;

// Internal hard caps — never shown to users; exist to prevent runaway abuse.
// Env vars allow tuning without a deploy. Values are per user per calendar month.
const INTERNAL_POST_CAP_EXPIRED = parseInt(process.env.INTERNAL_POST_CAP_EXPIRED || '0',   10);
const INTERNAL_POST_CAP_PRO    = parseInt(process.env.INTERNAL_POST_CAP_PRO    || '500', 10);
const INTERNAL_VISUAL_CAP_EXPIRED = parseInt(process.env.INTERNAL_VISUAL_CAP_EXPIRED || '0',   10);
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
  // Synthetic expired row — user has never subscribed
  return {
    user_id: userId,
    paddle_customer_id: null,
    paddle_subscription_id: null,
    plan: 'expired',
    status: 'expired',
    current_period_end: null,
    canceled_at: null,
    free_tier_started_at: null,
    free_posts_limit: FREE_POSTS_LIMIT,
  };
}

// ---------------------------------------------------------------------------
// getUserPlan
// Returns 'expired' | 'solo' | 'pro'.
// A canceled subscription retains access until current_period_end.
// Users without an active paid subscription (never subscribed, or lapsed) get
// 'expired' — canGeneratePost() gives that tier a lifetime free-post cap
// rather than zero access; see free_tier_started_at/free_posts_limit.
// ---------------------------------------------------------------------------
async function getUserPlan(userId) {
  const sub = await getUserSubscription(userId);
  // Lifetime plan: admin-granted, never expires, full Pro access.
  if (sub.status === 'lifetime') return 'pro';
  // Normalise to known tiers; unknown values fall back to expired.
  const tier = isPaidPlan(sub.plan) ? sub.plan : 'expired';
  if (tier === 'expired') return 'expired';
  if (!['active', 'trialing', 'canceled', 'past_due', 'paused'].includes(sub.status)) return 'expired';
  if (sub.status === 'canceled') {
    if (!sub.current_period_end) return 'expired';
    if (new Date(sub.current_period_end) <= new Date()) return 'expired';
  }
  // past_due: allow access during Paddle's retry window (~7–10 days), then lapse.
  if (sub.status === 'past_due' && sub.current_period_end) {
    const GRACE_MS = 14 * 24 * 60 * 60 * 1000;
    if (new Date(sub.current_period_end).getTime() + GRACE_MS < Date.now()) return 'expired';
  }
  return tier; // 'solo' | 'pro'
}

// ---------------------------------------------------------------------------
// The purchasable plans, and what each costs.
//
// Prices are declared here and charged by Paddle; these numbers are only what
// the UI prints. Paddle is the authority on what is actually billed, so a price
// changed there and not here shows the customer one number and charges another.
//
// A plan whose price ID is unset is not offered — see purchasablePlans(). That
// is what makes it safe to ship Deluxe before its Paddle price exists: the card
// simply does not appear, rather than opening a checkout that 500s.
// ---------------------------------------------------------------------------
const PLAN_CATALOG = {
  pro: {
    label: 'Pro',
    price: 19,
    tagline: 'For one person, one brand',
    priceIdEnv: 'PADDLE_PRICE_ID_PRO',
  },
  deluxe: {
    label: 'Deluxe',
    price: 49,
    tagline: 'For several brands, or a team',
    priceIdEnv: 'PADDLE_PRICE_ID_DELUXE',
  },
};

/** Catalog entry plus its resolved Paddle price ID, or null when unconfigured. */
function planCatalogEntry(plan) {
  const entry = PLAN_CATALOG[plan];
  if (!entry) return null;
  const priceId = (process.env[entry.priceIdEnv] || '').trim();
  return { plan, ...entry, priceId: priceId || null };
}

/** Plans that can actually be bought right now — those with a configured price. */
function purchasablePlans() {
  return Object.keys(PLAN_CATALOG)
    .map(planCatalogEntry)
    .filter(p => p && p.priceId);
}

/**
 * Maps a Paddle price ID back to one of our plans.
 * Returns null for an unrecognised price, which callers treat as "leave the
 * plan alone" rather than downgrading someone over an env var we forgot to set.
 */
function planForPriceId(priceId) {
  if (!priceId) return null;
  const yearly = (process.env.PADDLE_PRICE_ID_YEARLY || '').trim();
  if (yearly && priceId === yearly) return 'pro';
  for (const plan of Object.keys(PLAN_CATALOG)) {
    const entry = planCatalogEntry(plan);
    if (entry?.priceId && entry.priceId === priceId) return plan;
  }
  return null;
}

// ---------------------------------------------------------------------------
// getFoundingTierInfo
// Kept for the callers that just want "the default paid plan to show".
// ---------------------------------------------------------------------------
async function getFoundingTierInfo() {
  const pro = planCatalogEntry('pro');
  return {
    priceId: pro?.priceId,
    price: pro?.price ?? 19,
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
// solo/pro: counts quality-gate-passing posts this calendar month, per user
// (across all workspaces — user-governs model), against the plan's monthly quota.
// expired (free tier, incl. never-subscribed and lapsed users): counts
// quality-gate-passing posts since free_tier_started_at (lifetime, no reset)
// against free_posts_limit (default 3).
// Only rows with passed_gate = 1 count toward either limit.
// Returns { allowed, current, limit, plan, resets_at }.
// ---------------------------------------------------------------------------
async function canGeneratePost(userId) {
  const [sub, plan] = await Promise.all([getUserSubscription(userId), getUserPlan(userId)]);

  if (!isPaidPlan(plan)) {
    const limit = sub.free_posts_limit ?? FREE_POSTS_LIMIT;
    let current = 0;
    try {
      const row = await db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM generated_posts
        WHERE user_id = ?
          AND passed_gate = 1
          AND created_at >= COALESCE(?, '-infinity'::timestamptz)
      `).get(userId, sub.free_tier_started_at ?? null);
      current = parseInt(row?.cnt ?? 0, 10);
    } catch (err) {
      console.error('[subscription] canGeneratePost count error:', err.message);
      return { allowed: true, current: 0, limit, plan: 'expired', resets_at: null };
    }
    return { allowed: current < limit, current, limit, plan: 'expired', resets_at: null };
  }

  const rawLimit = getMonthlyPostLimit(plan); // 20 | Infinity
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

  // Preserves pre-existing solo/pro internal-cap behavior unchanged; the
  // free tier (handled above) no longer shares INTERNAL_POST_CAP_EXPIRED,
  // since that env var defaulting to 0 would zero out the new 3-post cap.
  const internalCap = plan === 'pro' ? INTERNAL_POST_CAP_PRO : INTERNAL_POST_CAP_EXPIRED;
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
  const internalCap = plan === 'pro' ? INTERNAL_VISUAL_CAP_PRO : INTERNAL_VISUAL_CAP_EXPIRED;
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
// canUploadVaultDoc
// solo/pro: unrestricted. Free tier (expired): capped at 1 document, counted
// per-user across all their workspaces. Not lifetime — the count is of rows
// that exist now, so deleting the document frees the slot.
//
// This is the only vault write the free tier gets; server.js exempts the upload
// path from the vault feature gate specifically so this cap is the thing that
// applies. Keep the two in step: re-gating /upload there makes this dead code
// again, which is how it spent months unreachable.
// ---------------------------------------------------------------------------
async function canUploadVaultDoc(userId) {
  const plan = await getUserPlan(userId);
  if (isPaidPlan(plan)) {
    return { allowed: true, current: 0, limit: null, plan };
  }

  const FREE_VAULT_DOC_LIMIT = 1;
  let current = 0;
  try {
    const row = await db.prepare(
      'SELECT COUNT(*) AS cnt FROM vault_documents WHERE user_id = ?'
    ).get(userId);
    current = parseInt(row?.cnt ?? 0, 10);
  } catch (err) {
    console.error('[subscription] canUploadVaultDoc count error:', err.message);
    return { allowed: true, current: 0, limit: FREE_VAULT_DOC_LIMIT, plan: 'expired' };
  }
  return { allowed: current < FREE_VAULT_DOC_LIMIT, current, limit: FREE_VAULT_DOC_LIMIT, plan: 'expired' };
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
    : 'expired';

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
// seedFreeSubscription
// Called on new-user signup. Inserts a free-tier row; the lifetime post cap
// comes from the free_posts_limit column default (migration 091 — FREE_POSTS_LIMIT
// here must match it), and is enforced by canGeneratePost. ON CONFLICT DO NOTHING
// ensures it never overwrites an existing subscription.
// ---------------------------------------------------------------------------
async function seedFreeSubscription(userId) {
  try {
    // plan stays 'expired' — chk_plan_values only allows 'expired'|'solo'|'pro'
    // (migration 066 removed 'free' as a plan value); 'free' is a status only.
    await db.prepare(`
      INSERT INTO user_subscriptions (user_id, plan, status)
      VALUES (?, 'expired', 'free')
      ON CONFLICT (user_id) DO NOTHING
    `).run(userId);
  } catch (err) {
    console.error('[subscription] seedFreeSubscription error (non-fatal):', err.message);
  }
}

module.exports = {
  FREE_POSTS_LIMIT,
  PLAN_CATALOG,
  planCatalogEntry,
  purchasablePlans,
  planForPriceId,
  getPaddle,
  getPaddleEnvironment,
  getUserSubscription,
  getUserPlan,
  getFoundingTierInfo,
  seedFreeSubscription,
  canGeneratePost,
  canGenerateVisual,
  logVisualGeneration,
  canUploadVaultDoc,
  getPaddleCustomerId,
  upsertSubscription,
  forceSyncSubscriptionForUser,
  INTERNAL_POST_CAP_EXPIRED,
  INTERNAL_POST_CAP_PRO,
  INTERNAL_VISUAL_CAP_EXPIRED,
  INTERNAL_VISUAL_CAP_PRO,
};

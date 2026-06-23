'use strict';

const { db, getSetting } = require('../db');
const { pool } = require('../db/pg');
const { getPaddle } = require('./subscription');
const {
  creditCommission,
  reverseCommission,
  getAffiliateById,
} = require('./affiliates');

let _running = false;

// Arbitrary fixed key for a PostgreSQL session-level advisory lock.
// Prevents concurrent reconciler runs across multiple server instances.
const RECONCILER_LOCK_KEY = 7463821;

/**
 * Daily reconciliation job — queries Paddle's Transactions API for all
 * referred customers and credits commissions not yet recorded.
 * Safe to run repeatedly: paddle_transaction_id UNIQUE constraint prevents
 * double-crediting.
 */
async function reconcileCommissions() {
  if (_running) {
    console.log('[affiliateReconciler] already running, skipping');
    return;
  }
  _running = true;
  const startedAt = Date.now();

  const pgClient = await pool.connect();
  let lockAcquired = false;

  try {
    // Try to acquire a DB-level advisory lock so only one instance runs at a time
    const lockResult = await pgClient.query(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [RECONCILER_LOCK_KEY]
    );
    lockAcquired = lockResult.rows[0]?.acquired === true;
    if (!lockAcquired) {
      console.log('[affiliateReconciler] lock held by another instance, skipping');
      return;
    }

    console.log('[affiliateReconciler] starting reconciliation');

    const active = await getSetting('affiliate_program_active');
    if (active === 'false') {
      console.log('[affiliateReconciler] program inactive, skipping');
      return;
    }

    const paddle = getPaddle();

    // All converted referrals with a Paddle customer ID
    const referrals = await db.prepare(`
      SELECT ar.id         AS referral_id,
             ar.affiliate_id,
             ar.referred_user_id,
             ar.converted_at,
             ar.status     AS referral_status,
             us.paddle_customer_id
      FROM   affiliate_referrals ar
      JOIN   user_subscriptions us ON us.user_id = ar.referred_user_id
      WHERE  ar.status IN ('converted', 'signed_up')
        AND  us.paddle_customer_id IS NOT NULL
    `).all();

    if (referrals.length === 0) {
      console.log('[affiliateReconciler] no referrals to check');
      return;
    }

    // Look back 48 h to catch anything from the previous run's window
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000);

    let credited = 0;
    let reversed = 0;
    let churned = 0;
    let errors = 0;

    for (const referral of referrals) {
      try {
        const affiliate = await getAffiliateById(referral.affiliate_id);
        if (!affiliate || affiliate.status !== 'active') continue;

        const ratePct = affiliate.commission_rate_pct > 0
          ? affiliate.commission_rate_pct
          : parseInt(await getSetting('affiliate_commission_rate_pct') || '10', 10);

        // Only reconcile payments for converted referrals
        if (referral.referral_status === 'converted') {
          // Fetch completed transactions for this customer — paginate through all pages
          let after = null;
          let hasMore = true;

          while (hasMore) {
            const params = {
              customerId: [referral.paddle_customer_id],
              status: ['completed'],
              ...(after ? { after } : {}),
            };
            const page = await paddle.transactions.list(params);
            const items = page?.data ?? (Array.isArray(page) ? page : []);

            for (const tx of items) {
              const txDate = new Date(tx.createdAt ?? tx.created_at ?? 0);
              // Client-side date filter — only process transactions since lookback window
              if (txDate < since) continue;

              const subtotal = parseFloat(
                tx.details?.totals?.subtotal ??
                tx.details?.totals?.total ??
                0
              );
              const amountCents = Math.round(subtotal * 100);
              if (amountCents <= 0) continue;

              const commissionCents = Math.round(amountCents * ratePct / 100);
              const convertedAt = referral.converted_at ? new Date(referral.converted_at) : null;
              const type = convertedAt && txDate > convertedAt ? 'renewal' : 'subscription';

              await creditCommission(
                referral.affiliate_id,
                referral.referral_id,
                commissionCents,
                tx.id,
                type
              );
              credited++;
            }

            // Advance cursor — check SDK pagination meta
            const pagination = page?.meta?.pagination ?? page?.meta ?? {};
            hasMore = !!(pagination.hasMore ?? pagination.has_more);
            after = pagination.next ?? (items.length ? items[items.length - 1]?.id : null);
            if (!items.length || !hasMore) break;
          }

          // Fetch refunds in the lookback window
          const refundPage = await paddle.transactions.list({
            customerId: [referral.paddle_customer_id],
            status: ['refunded'],
          });
          const refundItems = refundPage?.data ?? (Array.isArray(refundPage) ? refundPage : []);

          for (const tx of refundItems) {
            const txDate = new Date(tx.createdAt ?? tx.created_at ?? 0);
            if (txDate < since) continue;
            await reverseCommission(tx.id).catch(() => {});
            reversed++;
          }
        }

        // Churn detection: mark referral churned if subscription is canceled and past period end
        const sub = await db.prepare(
          'SELECT status, current_period_end FROM user_subscriptions WHERE user_id = ?'
        ).get(referral.referred_user_id);

        if (
          sub?.status === 'canceled' &&
          sub.current_period_end &&
          new Date(sub.current_period_end) < new Date() &&
          referral.referral_status === 'converted'
        ) {
          await db.prepare(`
            UPDATE affiliate_referrals
            SET status = 'churned', updated_at = now()
            WHERE id = ? AND status = 'converted'
          `).run(referral.referral_id);
          churned++;
        }
      } catch (err) {
        console.error(`[affiliateReconciler] error for referral=${referral.referral_id}:`, err.message);
        errors++;
      }
    }

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      `[affiliateReconciler] done — referrals=${referrals.length} credited=${credited} reversed=${reversed} churned=${churned} errors=${errors} elapsed=${elapsed}s`
    );
  } catch (err) {
    console.error('[affiliateReconciler] fatal error:', err.message);
  } finally {
    if (lockAcquired) {
      await pgClient.query('SELECT pg_advisory_unlock($1)', [RECONCILER_LOCK_KEY]).catch(() => {});
    }
    pgClient.release();
    _running = false;
  }
}

/**
 * Schedule the reconciler to run once at startup then every 24 hours.
 * Call this from server.js after the app is listening.
 */
function scheduleReconciler() {
  const INTERVAL_MS = 24 * 60 * 60 * 1000;

  // Delay initial run by 60 s to let the server finish booting
  setTimeout(() => {
    reconcileCommissions().catch(console.error);
    setInterval(() => reconcileCommissions().catch(console.error), INTERVAL_MS);
  }, 60_000);
}

module.exports = { reconcileCommissions, scheduleReconciler };

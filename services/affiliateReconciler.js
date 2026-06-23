'use strict';

const { db, getSetting } = require('../db');
const { getPaddle } = require('./subscription');
const {
  creditCommission,
  reverseCommission,
  getAffiliateById,
} = require('./affiliates');

let _running = false;

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
  console.log('[affiliateReconciler] starting reconciliation');

  try {
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
             us.paddle_customer_id
      FROM   affiliate_referrals ar
      JOIN   user_subscriptions us ON us.user_id = ar.referred_user_id
      WHERE  ar.status = 'converted'
        AND  us.paddle_customer_id IS NOT NULL
    `).all();

    if (referrals.length === 0) {
      console.log('[affiliateReconciler] no converted referrals to check');
      return;
    }

    // Look back 48 h to catch anything from the previous run's window
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000);

    let credited = 0;
    let reversed = 0;
    let errors = 0;

    for (const referral of referrals) {
      try {
        const affiliate = await getAffiliateById(referral.affiliate_id);
        if (!affiliate || affiliate.status !== 'active') continue;

        const ratePct = affiliate.commission_rate_pct > 0
          ? affiliate.commission_rate_pct
          : parseInt(await getSetting('affiliate_commission_rate_pct') || '10', 10);

        // Fetch completed transactions for this customer in the lookback window
        let after = since.toISOString();
        let hasMore = true;

        while (hasMore) {
          const page = await paddle.transactions.list({
            customerId: [referral.paddle_customer_id],
            status: ['completed'],
            // Paddle Node SDK uses camelCase options
          });

          hasMore = false; // SDK returns a collection; iterate items
          const items = page?.data ?? (Array.isArray(page) ? page : []);

          for (const tx of items) {
            const txDate = new Date(tx.createdAt ?? tx.created_at ?? 0);
            if (txDate < since) continue;

            // Calculate commission on the subscription subtotal (ex-tax)
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
        }

        // Check for refunds in the lookback window for this customer
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
      } catch (err) {
        console.error(`[affiliateReconciler] error for referral=${referral.referral_id}:`, err.message);
        errors++;
      }
    }

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      `[affiliateReconciler] done — referrals=${referrals.length} credited=${credited} reversed=${reversed} errors=${errors} elapsed=${elapsed}s`
    );
  } catch (err) {
    console.error('[affiliateReconciler] fatal error:', err.message);
  } finally {
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

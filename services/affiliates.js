'use strict';

const crypto = require('crypto');
const { db, getSetting } = require('../db');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genReferralCode() {
  return 'sh_' + crypto.randomBytes(4).toString('hex');
}

async function getEffectiveCommissionRate(affiliate) {
  if (affiliate.commission_rate_pct > 0) return affiliate.commission_rate_pct;
  const global = await getSetting('affiliate_commission_rate_pct');
  return parseInt(global || '10', 10);
}

// ---------------------------------------------------------------------------
// Join the program
// ---------------------------------------------------------------------------

async function joinProgram(userId) {
  const existing = await db.prepare('SELECT id FROM affiliates WHERE user_id = ?').get(userId);
  if (existing) {
    const err = new Error('already_affiliate');
    err.statusCode = 409;
    throw err;
  }

  const active = await getSetting('affiliate_program_active');
  if (active === 'false') {
    const err = new Error('program_inactive');
    err.statusCode = 403;
    throw err;
  }

  let code;
  for (let i = 0; i < 5; i++) {
    code = genReferralCode();
    const clash = await db.prepare('SELECT id FROM affiliates WHERE referral_code = ?').get(code);
    if (!clash) break;
    code = null;
  }
  if (!code) throw new Error('code_generation_failed');

  const row = await db.prepare(
    `INSERT INTO affiliates (user_id, referral_code) VALUES (?, ?) RETURNING *`
  ).get(userId, code);

  return row;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

async function getAffiliateByUserId(userId) {
  return db.prepare('SELECT * FROM affiliates WHERE user_id = ?').get(userId);
}

async function getAffiliateById(affiliateId) {
  return db.prepare('SELECT * FROM affiliates WHERE id = ?').get(affiliateId);
}

async function getAffiliateByCode(code) {
  return db.prepare(`SELECT * FROM affiliates WHERE referral_code = ? AND status = 'active'`).get(code);
}

// ---------------------------------------------------------------------------
// Click tracking
// ---------------------------------------------------------------------------

async function recordClick(code, ipHash) {
  await db.prepare(
    'INSERT INTO affiliate_clicks (referral_code, ip_hash) VALUES (?, ?)'
  ).run(code, ipHash || null);
}

// ---------------------------------------------------------------------------
// Attribution — called at user signup
// ---------------------------------------------------------------------------

async function attributeReferral(referredUserId, code) {
  if (!code || !referredUserId) return;

  const active = await getSetting('affiliate_program_active');
  if (active === 'false') return;

  const affiliate = await getAffiliateByCode(code);
  if (!affiliate) return;

  // Don't attribute to yourself
  if (affiliate.user_id === referredUserId) return;

  // Already attributed?
  const existing = await db.prepare(
    'SELECT id FROM affiliate_referrals WHERE referred_user_id = ?'
  ).get(referredUserId);
  if (existing) return;

  await db.prepare(`
    INSERT INTO affiliate_referrals (affiliate_id, referred_user_id, referral_code)
    VALUES (?, ?, ?)
    ON CONFLICT (referred_user_id) DO NOTHING
  `).run(affiliate.id, referredUserId, code);
}

// ---------------------------------------------------------------------------
// Mark referral converted (called on first confirmed payment)
// ---------------------------------------------------------------------------

async function markReferralConverted(referredUserId) {
  await db.prepare(`
    UPDATE affiliate_referrals
    SET status = 'converted', converted_at = COALESCE(converted_at, now())
    WHERE referred_user_id = ? AND status = 'signed_up'
  `).run(referredUserId);
}

// ---------------------------------------------------------------------------
// Credit a commission (idempotent on paddle_transaction_id)
// ---------------------------------------------------------------------------

async function creditCommission(affiliateId, referralId, amountCents, paddleTxId, type) {
  if (amountCents <= 0) return;

  // For subscription/renewal types, dedup by transaction ID
  if (paddleTxId) {
    const dupe = await db.prepare(
      'SELECT id FROM affiliate_commissions WHERE paddle_transaction_id = ?'
    ).get(paddleTxId);
    if (dupe) return;
  }

  const clearsAt = type !== 'bonus'
    ? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  await db.transaction(async (tx) => {
    await tx.prepare(`
      INSERT INTO affiliate_commissions
        (affiliate_id, referral_id, type, amount_cents, paddle_transaction_id, status, clears_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(affiliateId, referralId, type, amountCents, paddleTxId || null, clearsAt);

    await tx.prepare(`
      UPDATE affiliates
      SET wallet_balance_cents = wallet_balance_cents + ?,
          total_earned_cents   = total_earned_cents + ?,
          updated_at           = now()
      WHERE id = ?
    `).run(amountCents, amountCents, affiliateId);
  });
}

// ---------------------------------------------------------------------------
// Reverse a commission on refund
// ---------------------------------------------------------------------------

async function reverseCommission(paddleTxId) {
  if (!paddleTxId) return;

  const commission = await db.prepare(
    `SELECT * FROM affiliate_commissions WHERE paddle_transaction_id = ? AND status IN ('pending','confirmed')`
  ).get(paddleTxId);
  if (!commission) return;

  await db.transaction(async (tx) => {
    await tx.prepare(
      `UPDATE affiliate_commissions SET status = 'reversed' WHERE id = ?`
    ).run(commission.id);

    await tx.prepare(`
      UPDATE affiliates
      SET wallet_balance_cents = GREATEST(0, wallet_balance_cents - ?),
          total_earned_cents   = GREATEST(0, total_earned_cents - ?),
          updated_at           = now()
      WHERE id = ?
    `).run(commission.amount_cents, commission.amount_cents, commission.affiliate_id);
  });
}

// ---------------------------------------------------------------------------
// Confirm cleared commissions (past 14-day refund window)
// ---------------------------------------------------------------------------

async function confirmClearedCommissions() {
  await db.prepare(`
    UPDATE affiliate_commissions
    SET status = 'confirmed'
    WHERE status = 'pending'
      AND clears_at IS NOT NULL
      AND clears_at <= now()
  `).run();
}

// ---------------------------------------------------------------------------
// Milestone bonus check — called after each post publish
// ---------------------------------------------------------------------------

async function checkMilestoneBonus(referredUserId) {
  const referral = await db.prepare(
    'SELECT * FROM affiliate_referrals WHERE referred_user_id = ?'
  ).get(referredUserId);
  if (!referral || referral.milestone_bonus_paid) return;

  const milestoneStr = await getSetting('affiliate_milestone_posts');
  const milestone = parseInt(milestoneStr || '100', 10);

  const newCount = (referral.total_posts_published || 0) + 1;

  await db.prepare(
    'UPDATE affiliate_referrals SET total_posts_published = ? WHERE referred_user_id = ?'
  ).run(newCount, referredUserId);

  if (newCount >= milestone) {
    const bonusCentsStr = await getSetting('affiliate_bonus_cents');
    const bonusCents = parseInt(bonusCentsStr || '200', 10);

    await db.prepare(
      'UPDATE affiliate_referrals SET milestone_bonus_paid = true WHERE referred_user_id = ?'
    ).run(referredUserId);

    await creditCommission(
      referral.affiliate_id,
      referral.id,
      bonusCents,
      null,
      'bonus'
    );
  }
}

// ---------------------------------------------------------------------------
// Request a payout
// ---------------------------------------------------------------------------

async function requestPayout(affiliateId) {
  await confirmClearedCommissions();

  const affiliate = await getAffiliateById(affiliateId);
  if (!affiliate) throw Object.assign(new Error('affiliate_not_found'), { statusCode: 404 });
  if (affiliate.status !== 'active') throw Object.assign(new Error('affiliate_not_active'), { statusCode: 403 });

  const minStr = await getSetting('affiliate_min_payout_cents');
  const minCents = parseInt(minStr || '1000', 10);

  // Only count confirmed (cleared) commissions toward payable balance
  const confirmedRow = await db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0)::int AS total
    FROM affiliate_commissions
    WHERE affiliate_id = ? AND status = 'confirmed'
  `).get(affiliateId);
  const confirmedBalance = confirmedRow?.total || 0;

  if (confirmedBalance < minCents) {
    const err = new Error('insufficient_balance');
    err.statusCode = 400;
    err.confirmedBalance = confirmedBalance;
    err.minCents = minCents;
    throw err;
  }

  // Check no in-flight payout
  const inflight = await db.prepare(
    `SELECT id FROM affiliate_payouts WHERE affiliate_id = ? AND status = 'pending'`
  ).get(affiliateId);
  if (inflight) throw Object.assign(new Error('payout_in_flight'), { statusCode: 409 });

  await db.transaction(async (tx) => {
    await tx.prepare(`
      INSERT INTO affiliate_payouts (affiliate_id, amount_cents)
      VALUES (?, ?)
    `).run(affiliateId, confirmedBalance);

    // Debit wallet and mark commissions paid
    await tx.prepare(`
      UPDATE affiliates
      SET wallet_balance_cents = GREATEST(0, wallet_balance_cents - ?),
          updated_at = now()
      WHERE id = ?
    `).run(confirmedBalance, affiliateId);

    await tx.prepare(`
      UPDATE affiliate_commissions
      SET status = 'paid'
      WHERE affiliate_id = ? AND status = 'confirmed'
    `).run(affiliateId);
  });
}

// ---------------------------------------------------------------------------
// Admin: mark a payout as paid
// ---------------------------------------------------------------------------

async function markPayoutPaid(payoutId, note) {
  const payout = await db.prepare(
    `SELECT * FROM affiliate_payouts WHERE id = ? AND status = 'pending'`
  ).get(payoutId);
  if (!payout) throw Object.assign(new Error('payout_not_found'), { statusCode: 404 });

  await db.transaction(async (tx) => {
    await tx.prepare(`
      UPDATE affiliate_payouts SET status = 'paid', paid_at = now(), note = ? WHERE id = ?
    `).run(note || null, payoutId);

    await tx.prepare(`
      UPDATE affiliates
      SET total_paid_cents = total_paid_cents + ?, updated_at = now()
      WHERE id = ?
    `).run(payout.amount_cents, payout.affiliate_id);
  });
}

// ---------------------------------------------------------------------------
// Admin: get summary stats
// ---------------------------------------------------------------------------

async function getAdminSummary() {
  const [totalRow, paidRow, walletRow, payoutsRow] = await Promise.all([
    db.prepare(`SELECT COUNT(*)::int AS total FROM affiliates WHERE status = 'active'`).get(),
    db.prepare(`SELECT COALESCE(SUM(total_paid_cents), 0)::int AS total FROM affiliates`).get(),
    db.prepare(`SELECT COALESCE(SUM(wallet_balance_cents), 0)::int AS total FROM affiliates`).get(),
    db.prepare(`SELECT COUNT(*)::int AS total FROM affiliate_payouts WHERE status = 'pending'`).get(),
  ]);
  return {
    activeAffiliates: totalRow?.total || 0,
    totalPaidCents: paidRow?.total || 0,
    pendingWalletCents: walletRow?.total || 0,
    pendingPayouts: payoutsRow?.total || 0,
  };
}

// ---------------------------------------------------------------------------
// Admin: list affiliates
// ---------------------------------------------------------------------------

async function listAffiliates({ limit = 50, offset = 0, status } = {}) {
  const conditions = status ? [`a.status = '${status}'`] : [];
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  return db.prepare(`
    SELECT a.*,
      up.email, up.display_name,
      (SELECT COUNT(*)::int FROM affiliate_referrals ar WHERE ar.affiliate_id = a.id) AS referral_count,
      (SELECT COUNT(*)::int FROM affiliate_referrals ar WHERE ar.affiliate_id = a.id AND ar.status = 'converted') AS converted_count
    FROM affiliates a
    JOIN user_profiles up ON up.id = a.user_id
    ${where}
    ORDER BY a.total_earned_cents DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

// ---------------------------------------------------------------------------
// Admin: detail view
// ---------------------------------------------------------------------------

async function getAffiliateDetail(affiliateId) {
  const [affiliate, commissions, referrals, payouts] = await Promise.all([
    db.prepare(`
      SELECT a.*, up.email, up.display_name
      FROM affiliates a
      JOIN user_profiles up ON up.id = a.user_id
      WHERE a.id = ?
    `).get(affiliateId),
    db.prepare(`
      SELECT * FROM affiliate_commissions WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 200
    `).all(affiliateId),
    db.prepare(`
      SELECT ar.*, up.email, up.display_name
      FROM affiliate_referrals ar
      JOIN user_profiles up ON up.id = ar.referred_user_id
      WHERE ar.affiliate_id = ?
      ORDER BY ar.created_at DESC
    `).all(affiliateId),
    db.prepare(`
      SELECT * FROM affiliate_payouts WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 50
    `).all(affiliateId),
  ]);

  return { affiliate, commissions, referrals, payouts };
}

// ---------------------------------------------------------------------------
// Admin: pending payouts (ready for processing)
// ---------------------------------------------------------------------------

async function getPendingPayouts() {
  await confirmClearedCommissions();

  return db.prepare(`
    SELECT ap.*, a.payout_method_type, a.payout_method_details,
           up.email, up.display_name
    FROM affiliate_payouts ap
    JOIN affiliates a ON a.id = ap.affiliate_id
    JOIN user_profiles up ON up.id = a.user_id
    WHERE ap.status = 'pending'
    ORDER BY ap.created_at ASC
  `).all();
}

// ---------------------------------------------------------------------------
// Admin: affiliates eligible to request payout (for batch processing)
// ---------------------------------------------------------------------------

async function getPayoutEligibleAffiliates() {
  await confirmClearedCommissions();

  const minStr = await getSetting('affiliate_min_payout_cents');
  const minCents = parseInt(minStr || '1000', 10);

  return db.prepare(`
    SELECT a.id, a.payout_method_type, a.payout_method_details,
           up.email, up.display_name,
           COALESCE(SUM(ac.amount_cents), 0)::int AS confirmed_balance_cents
    FROM affiliates a
    JOIN user_profiles up ON up.id = a.user_id
    LEFT JOIN affiliate_commissions ac
      ON ac.affiliate_id = a.id AND ac.status = 'confirmed'
    WHERE a.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM affiliate_payouts ap
        WHERE ap.affiliate_id = a.id AND ap.status = 'pending'
      )
    GROUP BY a.id, up.email, up.display_name
    HAVING COALESCE(SUM(ac.amount_cents), 0) >= ?
    ORDER BY confirmed_balance_cents DESC
  `).all(minCents);
}

module.exports = {
  joinProgram,
  getAffiliateByUserId,
  getAffiliateById,
  getAffiliateByCode,
  recordClick,
  attributeReferral,
  markReferralConverted,
  creditCommission,
  reverseCommission,
  confirmClearedCommissions,
  checkMilestoneBonus,
  requestPayout,
  markPayoutPaid,
  getAdminSummary,
  listAffiliates,
  getAffiliateDetail,
  getPendingPayouts,
  getPayoutEligibleAffiliates,
};

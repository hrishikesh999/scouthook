'use strict';

const express = require('express');
const router = express.Router();
const {
  joinProgram,
  getAffiliateByUserId,
  requestPayout,
} = require('../services/affiliates');
const { db, getSetting } = require('../db');

function requireAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ ok: false, error: 'unauthenticated' });
  next();
}

// ---------------------------------------------------------------------------
// POST /api/affiliates/join
// ---------------------------------------------------------------------------
router.post('/join', requireAuth, async (req, res) => {
  try {
    const affiliate = await joinProgram(req.userId);
    return res.json({ ok: true, affiliate });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/affiliates/me
// ---------------------------------------------------------------------------
router.get('/me', requireAuth, async (req, res) => {
  try {
    const affiliate = await getAffiliateByUserId(req.userId);
    if (!affiliate) return res.status(404).json({ ok: false, error: 'not_affiliate' });

    const [clickCount, referralStats, minPayout, pendingRow] = await Promise.all([
      db.prepare(
        'SELECT COUNT(*)::int AS cnt FROM affiliate_clicks WHERE referral_code = ?'
      ).get(affiliate.referral_code),
      db.prepare(`
        SELECT
          COUNT(*)::int                                                AS total_referrals,
          COUNT(*) FILTER (WHERE status = 'converted')::int           AS converted,
          COALESCE(SUM(total_posts_published), 0)::int                AS total_posts
        FROM affiliate_referrals WHERE affiliate_id = ?
      `).get(affiliate.id),
      getSetting('affiliate_min_payout_cents'),
      db.prepare(`
        SELECT COALESCE(SUM(amount_cents), 0)::int AS total
        FROM affiliate_commissions
        WHERE affiliate_id = ? AND status = 'pending'
      `).get(affiliate.id),
    ]);

    const appUrl = process.env.APP_URL || '';
    return res.json({
      ok: true,
      affiliate: {
        ...affiliate,
        referral_link: `${appUrl}?ref=${affiliate.referral_code}`,
        click_count: clickCount?.cnt || 0,
        total_referrals: referralStats?.total_referrals || 0,
        converted_referrals: referralStats?.converted || 0,
        total_posts_across_referrals: referralStats?.total_posts || 0,
        min_payout_cents: parseInt(minPayout || '1000', 10),
        pending_balance_cents: pendingRow?.total || 0,
      },
    });
  } catch (err) {
    console.error('[affiliates] /me error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/affiliates/commissions
// ---------------------------------------------------------------------------
router.get('/commissions', requireAuth, async (req, res) => {
  try {
    const affiliate = await getAffiliateByUserId(req.userId);
    if (!affiliate) return res.status(404).json({ ok: false, error: 'not_affiliate' });

    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);

    const commissions = await db.prepare(`
      SELECT * FROM affiliate_commissions
      WHERE affiliate_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(affiliate.id, limit, offset);

    return res.json({ ok: true, commissions });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/affiliates/referrals
// ---------------------------------------------------------------------------
router.get('/referrals', requireAuth, async (req, res) => {
  try {
    const affiliate = await getAffiliateByUserId(req.userId);
    if (!affiliate) return res.status(404).json({ ok: false, error: 'not_affiliate' });

    const rows = await db.prepare(`
      SELECT ar.id, ar.status, ar.signed_up_at, ar.converted_at,
             ar.total_posts_published, ar.milestone_bonus_paid,
             up.display_name,
             CONCAT(LEFT(up.email, 2), '***@', SPLIT_PART(up.email, '@', 2)) AS masked_email
      FROM affiliate_referrals ar
      JOIN user_profiles up ON up.user_id = ar.referred_user_id
      WHERE ar.affiliate_id = ?
      ORDER BY ar.created_at DESC
    `).all(affiliate.id);

    return res.json({ ok: true, referrals: rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/affiliates/payouts
// ---------------------------------------------------------------------------
router.get('/payouts', requireAuth, async (req, res) => {
  try {
    const affiliate = await getAffiliateByUserId(req.userId);
    if (!affiliate) return res.status(404).json({ ok: false, error: 'not_affiliate' });

    const payouts = await db.prepare(`
      SELECT * FROM affiliate_payouts WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 50
    `).all(affiliate.id);

    return res.json({ ok: true, payouts });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/affiliates/payout/request
// ---------------------------------------------------------------------------
router.post('/payout/request', requireAuth, async (req, res) => {
  try {
    const affiliate = await getAffiliateByUserId(req.userId);
    if (!affiliate) return res.status(404).json({ ok: false, error: 'not_affiliate' });

    await requestPayout(affiliate.id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      ok: false,
      error: err.message,
      confirmedBalance: err.confirmedBalance,
      minCents: err.minCents,
    });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/affiliates/payout-method
// ---------------------------------------------------------------------------
router.put('/payout-method', requireAuth, async (req, res) => {
  try {
    const affiliate = await getAffiliateByUserId(req.userId);
    if (!affiliate) return res.status(404).json({ ok: false, error: 'not_affiliate' });

    const { payout_method_type, payout_method_details } = req.body || {};
    if (payout_method_type && payout_method_type !== 'paypal') {
      return res.status(400).json({ ok: false, error: 'invalid_payout_method_type' });
    }

    await db.prepare(`
      UPDATE affiliates
      SET payout_method_type = ?, payout_method_details = ?, updated_at = now()
      WHERE id = ?
    `).run(payout_method_type || null, payout_method_details || null, affiliate.id);

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

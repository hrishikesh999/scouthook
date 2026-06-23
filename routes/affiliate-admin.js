'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const router = express.Router();
const { getSetting, setSetting } = require('../db');
const {
  getAdminSummary,
  listAffiliates,
  getAffiliateDetail,
  getAffiliateById,
  markPayoutPaid,
  getPendingPayouts,
  getPayoutEligibleAffiliates,
} = require('../services/affiliates');
const { reconcileCommissions } = require('../services/affiliateReconciler');
const { db } = require('../db');

if (!process.env.AFFILIATE_ADMIN_PASSWORD) {
  console.warn('[affiliate-admin] AFFILIATE_ADMIN_PASSWORD is not set — admin routes will be inaccessible');
}

const AFFILIATE_ADMIN_PASSWORD = process.env.AFFILIATE_ADMIN_PASSWORD || '';

function requireAffiliateAdmin(req, res, next) {
  const provided =
    req.headers['x-affiliate-admin-password'] ||
    req.headers['x-affiliate-admin'] ||
    req.body?.admin_password;
  if (!AFFILIATE_ADMIN_PASSWORD || provided !== AFFILIATE_ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

const AFFILIATE_CONFIG_KEYS = [
  'affiliate_commission_rate_pct',
  'affiliate_bonus_cents',
  'affiliate_milestone_posts',
  'affiliate_min_payout_cents',
  'affiliate_program_active',
];

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_attempts' },
});

// ---------------------------------------------------------------------------
// POST /affiliate-admin/auth  — verify password (for UI login)
// ---------------------------------------------------------------------------
router.post('/auth', authLimiter, (req, res) => {
  const { password } = req.body || {};
  if (!AFFILIATE_ADMIN_PASSWORD || password !== AFFILIATE_ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'invalid_password' });
  }
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /affiliate-admin/stats
// ---------------------------------------------------------------------------
router.get('/stats', requireAffiliateAdmin, async (req, res) => {
  try {
    const stats = await getAdminSummary();
    return res.json({ ok: true, stats });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /affiliate-admin/affiliates
// ---------------------------------------------------------------------------
router.get('/affiliates', requireAffiliateAdmin, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '50',  10), 200);
    const offset = parseInt(req.query.offset || '0', 10);
    const VALID = ['active', 'inactive', 'suspended'];
    const status = VALID.includes(req.query.status) ? req.query.status : null;

    const affiliates = await listAffiliates({ limit, offset, status });
    return res.json({ ok: true, affiliates });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /affiliate-admin/affiliates/:id
// ---------------------------------------------------------------------------
router.get('/affiliates/:id', requireAffiliateAdmin, async (req, res) => {
  try {
    const detail = await getAffiliateDetail(req.params.id);
    if (!detail.affiliate) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.json({ ok: true, ...detail });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /affiliate-admin/affiliates/:id/status
// ---------------------------------------------------------------------------
router.post('/affiliates/:id/status', requireAffiliateAdmin, async (req, res) => {
  try {
    const { status } = req.body || {};
    const allowed = ['active', 'inactive', 'suspended'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ ok: false, error: 'invalid_status' });
    }
    await db.prepare(
      `UPDATE affiliates SET status = ?, updated_at = now() WHERE id = ?`
    ).run(status, req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /affiliate-admin/affiliates/:id/commission
// ---------------------------------------------------------------------------
router.post('/affiliates/:id/commission', requireAffiliateAdmin, async (req, res) => {
  try {
    const rate = parseInt(req.body?.commission_rate_pct, 10);
    if (isNaN(rate) || rate < 0 || rate > 100) {
      return res.status(400).json({ ok: false, error: 'rate must be 0–100' });
    }
    await db.prepare(
      `UPDATE affiliates SET commission_rate_pct = ?, updated_at = now() WHERE id = ?`
    ).run(rate, req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /affiliate-admin/payouts/pending  — payouts already requested (awaiting admin action)
// ---------------------------------------------------------------------------
router.get('/payouts/pending', requireAffiliateAdmin, async (req, res) => {
  try {
    const payouts = await getPendingPayouts();
    return res.json({ ok: true, payouts });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /affiliate-admin/payouts/eligible  — affiliates eligible to be paid (cleared balance ≥ min)
// ---------------------------------------------------------------------------
router.get('/payouts/eligible', requireAffiliateAdmin, async (req, res) => {
  try {
    const eligible = await getPayoutEligibleAffiliates();
    return res.json({ ok: true, eligible });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /affiliate-admin/payouts/:payoutId/mark-paid
// ---------------------------------------------------------------------------
router.post('/payouts/:payoutId/mark-paid', requireAffiliateAdmin, async (req, res) => {
  try {
    const { note } = req.body || {};
    await markPayoutPaid(req.params.payoutId, note);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /affiliate-admin/payouts/batch-pay  — mark multiple payouts paid
// ---------------------------------------------------------------------------
router.post('/payouts/batch-pay', requireAffiliateAdmin, async (req, res) => {
  const { payout_ids, note } = req.body || {};
  if (!Array.isArray(payout_ids) || payout_ids.length === 0) {
    return res.status(400).json({ ok: false, error: 'payout_ids array required' });
  }
  const results = [];
  for (const id of payout_ids) {
    try {
      await markPayoutPaid(id, note);
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err.message });
    }
  }
  return res.json({ ok: true, results });
});

// ---------------------------------------------------------------------------
// GET /affiliate-admin/config
// ---------------------------------------------------------------------------
router.get('/config', requireAffiliateAdmin, async (req, res) => {
  try {
    const config = {};
    for (const key of AFFILIATE_CONFIG_KEYS) {
      config[key] = await getSetting(key);
    }
    return res.json({ ok: true, config });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /affiliate-admin/config
// ---------------------------------------------------------------------------
router.post('/config', requireAffiliateAdmin, async (req, res) => {
  try {
    const updates = req.body?.config || req.body || {};
    for (const [key, value] of Object.entries(updates)) {
      if (!AFFILIATE_CONFIG_KEYS.includes(key)) continue;
      await setSetting(key, String(value));
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /affiliate-admin/reconcile  — trigger immediate reconciliation
// ---------------------------------------------------------------------------
router.post('/reconcile', requireAffiliateAdmin, async (req, res) => {
  // Fire-and-forget so the HTTP response returns quickly
  reconcileCommissions().catch(err => console.error('[affiliate-admin] reconcile error:', err.message));
  return res.json({ ok: true, message: 'reconciliation started' });
});

module.exports = router;

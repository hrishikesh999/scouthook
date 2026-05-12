'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { sendEmail, getUserEmailInfo } = require('../emails');

function requireAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ ok: false, error: 'unauthenticated' });
  next();
}

// ---------------------------------------------------------------------------
// POST /api/feedback
// Stores user feedback and emails the admin.
// ---------------------------------------------------------------------------
router.post('/', requireAuth, async (req, res) => {
  const { message, rating, page_url } = req.body ?? {};

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'message is required' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ ok: false, error: 'message too long' });
  }

  const ratingVal = rating != null ? parseInt(rating, 10) : null;
  if (ratingVal !== null && (isNaN(ratingVal) || ratingVal < 1 || ratingVal > 5)) {
    return res.status(400).json({ ok: false, error: 'rating must be 1–5' });
  }

  const pageUrl = typeof page_url === 'string' ? page_url.slice(0, 500) : null;
  const userId = req.userId;

  try {
    await db.prepare(
      'INSERT INTO feedback (user_id, message, rating, page_url) VALUES ($1, $2, $3, $4)'
    ).run(userId, message.trim(), ratingVal, pageUrl);
  } catch (err) {
    console.error('[feedback] DB insert failed:', err.message);
    return res.status(500).json({ ok: false, error: 'could not save feedback' });
  }

  // Fire-and-forget admin notification
  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail) {
    const userInfo = await getUserEmailInfo(userId).catch(() => null);
    const ratingDisplay = ratingVal ? `${'★'.repeat(ratingVal)}${'☆'.repeat(5 - ratingVal)} (${ratingVal}/5)` : 'Not rated';
    const appUrl = process.env.APP_URL || '';
    sendEmail('feedback-received', adminEmail, {
      user_name: userInfo?.name || 'Unknown',
      user_email: userInfo?.email || userId,
      message: message.trim(),
      rating: ratingDisplay,
      page_url: pageUrl || '—',
      submitted_at: new Date().toUTCString(),
      app_url: appUrl,
    }).catch(() => {});
  }

  res.json({ ok: true });
});

module.exports = router;

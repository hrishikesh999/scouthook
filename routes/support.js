'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { sendEmail, getUserEmailInfo } = require('../emails');

const VALID_TOPICS = ['LinkedIn connection', 'Publishing issue', 'Scheduling', 'Billing', 'Other'];

function requireAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ ok: false, error: 'unauthenticated' });
  next();
}

// ---------------------------------------------------------------------------
// POST /api/support
// Stores a support request, emails admin, and sends a confirmation to the user.
// ---------------------------------------------------------------------------
router.post('/', requireAuth, async (req, res) => {
  const { topic, message } = req.body ?? {};

  if (!topic || !VALID_TOPICS.includes(topic)) {
    return res.status(400).json({ ok: false, error: 'valid topic is required' });
  }
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'message is required' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ ok: false, error: 'message too long' });
  }

  const userId = req.userId;

  try {
    await db.prepare(
      'INSERT INTO support_requests (user_id, topic, message) VALUES ($1, $2, $3)'
    ).run(userId, topic, message.trim());
  } catch (err) {
    console.error('[support] DB insert failed:', err.message);
    return res.status(500).json({ ok: false, error: 'could not save request' });
  }

  // Fire-and-forget emails
  const userInfo = await getUserEmailInfo(userId).catch(() => null);
  const appUrl = process.env.APP_URL || '';

  // Check if user is Pro (for admin triage badge)
  let isPro = false;
  try {
    const row = await db.prepare(
      "SELECT plan FROM user_profiles WHERE user_id = $1"
    ).get(userId);
    isPro = row?.plan === 'pro';
  } catch { /* ignore */ }

  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail) {
    sendEmail('support-request', adminEmail, {
      user_name:  userInfo?.name  || 'Unknown',
      user_email: userInfo?.email || userId,
      topic,
      message:    message.trim(),
      plan_badge: isPro ? '⭐ Pro' : 'Free',
      submitted_at: new Date().toUTCString(),
      app_url: appUrl,
    }).catch(() => {});
  }

  // Confirmation to the user
  if (userInfo?.email) {
    sendEmail('support-received', userInfo.email, {
      user_name: userInfo.name || 'there',
      topic,
      app_url: appUrl,
    }).catch(() => {});
  }

  res.json({ ok: true });
});

module.exports = router;

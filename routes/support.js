'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { sendEmail, getUserEmailInfo } = require('../emails');

const VALID_TOPICS = ['LinkedIn connection', 'Publishing issue', 'Scheduling', 'Billing', 'Other'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// POST /api/support
// Stores a support request, emails admin, and sends a confirmation to the
// submitter. Works both for logged-in users (identified by session) and
// logged-out visitors (identified by the email they supply).
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { topic, message } = req.body ?? {};
  const userId = req.userId || null;
  const guestEmail = typeof req.body?.email === 'string' ? req.body.email.trim() : '';

  if (!topic || !VALID_TOPICS.includes(topic)) {
    return res.status(400).json({ ok: false, error: 'valid topic is required' });
  }
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'message is required' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ ok: false, error: 'message too long' });
  }
  if (!userId && !EMAIL_RE.test(guestEmail)) {
    return res.status(400).json({ ok: false, error: 'valid email is required' });
  }

  try {
    await db.prepare(
      'INSERT INTO support_requests (user_id, guest_email, topic, message) VALUES ($1, $2, $3, $4)'
    ).run(userId, userId ? null : guestEmail, topic, message.trim());
  } catch (err) {
    console.error('[support] DB insert failed:', err.message);
    return res.status(500).json({ ok: false, error: 'could not save request' });
  }

  // Fire-and-forget emails
  const userInfo = userId ? await getUserEmailInfo(userId).catch(() => null) : null;
  const submitterEmail = userInfo?.email || guestEmail;
  const submitterName  = userInfo?.name  || 'there';
  const appUrl = process.env.APP_URL || '';

  // Check if user is Pro (for admin triage badge)
  let isPro = false;
  if (userId) {
    try {
      const row = await db.prepare(
        "SELECT plan FROM user_profiles WHERE user_id = $1"
      ).get(userId);
      isPro = row?.plan === 'pro';
    } catch { /* ignore */ }
  }

  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail) {
    sendEmail('support-request', adminEmail, {
      user_name:  userInfo?.name || 'Guest (not logged in)',
      user_email: submitterEmail || userId,
      topic,
      message:    message.trim(),
      plan_badge: userId ? (isPro ? '⭐ Pro' : 'Trial/Expired') : 'Guest',
      submitted_at: new Date().toUTCString(),
      app_url: appUrl,
    }).catch(() => {});
  }

  // Confirmation to the submitter
  if (submitterEmail) {
    sendEmail('support-received', submitterEmail, {
      user_name: submitterName,
      topic,
      app_url: appUrl,
    }).catch(() => {});
  }

  res.json({ ok: true });
});

module.exports = router;

'use strict';

const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const router  = express.Router();
const { db } = require('../db');
const { sendEmail, getUserEmailInfo } = require('../emails');
const storage = require('../services/storage');

function requireAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ ok: false, error: 'unauthenticated' });
  next();
}

// ---------------------------------------------------------------------------
// POST /api/feedback/upload
// Accepts a raw image body and stores it in R2 under feedback/{uuid}.{ext}.
// Returns { ok: true, url } where url is the app-served path.
// ---------------------------------------------------------------------------
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_BYTES    = 5 * 1024 * 1024; // 5 MB

router.post('/upload', requireAuth, express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const mimeType = (req.headers['content-type'] || '').split(';')[0].trim();
  if (!ALLOWED_MIME.has(mimeType)) {
    return res.status(400).json({ ok: false, error: 'unsupported_type' });
  }
  const buffer = req.body;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return res.status(400).json({ ok: false, error: 'empty_body' });
  }
  if (buffer.length > MAX_BYTES) {
    return res.status(400).json({ ok: false, error: 'file_too_large' });
  }

  const ext      = mimeType.split('/')[1].replace('jpeg', 'jpg');
  const filename = `${crypto.randomUUID()}.${ext}`;
  const key      = storage.buildFeedbackKey(filename);

  try {
    await storage.uploadToKey(buffer, key, mimeType);
    const url = `/feedback-attachment/${filename}`;
    return res.json({ ok: true, url });
  } catch (err) {
    console.error('[feedback/upload] storage error:', err.message);
    return res.status(500).json({ ok: false, error: 'upload_failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/feedback
// Stores user feedback and emails the admin.
// ---------------------------------------------------------------------------
const VALID_CATEGORIES = ['feature_request', 'bug_report', 'improvement'];

router.post('/', requireAuth, async (req, res) => {
  const { message, title, rating, category, page_url, attachment_url } = req.body ?? {};

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

  const categoryVal   = typeof category === 'string' && VALID_CATEGORIES.includes(category) ? category : null;
  const titleVal      = typeof title === 'string' ? title.slice(0, 120).trim() : null;
  const pageUrl       = typeof page_url === 'string' ? page_url.slice(0, 500) : null;
  const attachmentUrl = typeof attachment_url === 'string' && attachment_url.startsWith('/feedback-attachment/') ? attachment_url : null;
  const userId = req.userId;

  try {
    await db.prepare(
      'INSERT INTO feedback (user_id, message, rating, page_url, category, attachment_url) VALUES ($1, $2, $3, $4, $5, $6)'
    ).run(userId, message.trim(), ratingVal, pageUrl, categoryVal, attachmentUrl);
  } catch (err) {
    console.error('[feedback] DB insert failed:', err.message);
    return res.status(500).json({ ok: false, error: 'could not save feedback' });
  }

  // Fire-and-forget admin notification
  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail) {
    const userInfo = await getUserEmailInfo(userId).catch(() => null);
    const ratingDisplay = ratingVal ? `${'★'.repeat(ratingVal)}${'☆'.repeat(5 - ratingVal)} (${ratingVal}/5)` : 'Not rated';
    const categoryDisplay = categoryVal ? categoryVal.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—';
    const appUrl = process.env.APP_URL || '';
    const attachmentHtml = attachmentUrl
      ? `<p style="margin:16px 0 0"><a href="${appUrl}${attachmentUrl}" target="_blank"><img src="${appUrl}${attachmentUrl}" alt="Attachment" style="max-width:100%;border-radius:6px;border:1px solid #e5e7eb;"></a></p>`
      : '';
    sendEmail('feedback-received', adminEmail, {
      user_name: userInfo?.name || 'Unknown',
      user_email: userInfo?.email || userId,
      title: titleVal || '—',
      message: message.trim(),
      rating: ratingDisplay,
      category: categoryDisplay,
      page_url: pageUrl || '—',
      submitted_at: new Date().toUTCString(),
      app_url: appUrl,
      attachment_html: attachmentHtml,
    }).catch(() => {});
  }

  res.json({ ok: true });
});

module.exports = router;

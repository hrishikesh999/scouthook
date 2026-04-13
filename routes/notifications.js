'use strict';

const express = require('express');
const router  = express.Router();
const { db }  = require('../db');

// ---------------------------------------------------------------------------
// GET /api/notifications
// Returns unread notifications for the authenticated user.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const { userId, tenantId } = req;
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated' });

  const rows = await db.prepare(`
    SELECT id, type, title, body, ref_id, ref_type, created_at
    FROM   notifications
    WHERE  user_id = ? AND tenant_id = ? AND read_at IS NULL
    ORDER  BY created_at DESC
    LIMIT  50
  `).all(userId, tenantId);

  return res.json({ ok: true, notifications: rows });
});

// ---------------------------------------------------------------------------
// POST /api/notifications/read
// Marks one or all unread notifications as read.
// Body: { id?: number }  — omit `id` to mark all as read.
// ---------------------------------------------------------------------------
router.post('/read', async (req, res) => {
  const { userId, tenantId } = req;
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated' });

  const { id } = req.body || {};

  if (id != null) {
    await db.prepare(`
      UPDATE notifications
      SET read_at = now()
      WHERE id = ? AND user_id = ? AND tenant_id = ? AND read_at IS NULL
    `).run(Number(id), userId, tenantId);
  } else {
    await db.prepare(`
      UPDATE notifications
      SET read_at = now()
      WHERE user_id = ? AND tenant_id = ? AND read_at IS NULL
    `).run(userId, tenantId);
  }

  return res.json({ ok: true });
});

module.exports = router;

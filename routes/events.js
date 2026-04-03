'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');

// ---------------------------------------------------------------------------
// POST /api/events/copy
// Feedback loop — one line on the copy button. Fire and forget from client.
// Never blocks the copy action on failure.
// ---------------------------------------------------------------------------
router.post('/copy', (req, res) => {
  const { post_id, run_id, path, format_slug } = req.body;
  const tenantId = req.tenantId;
  const userId = req.userId;

  // TODO (Session 1): Uncomment once user_id header enforcement is decided
  // if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  try {
    db.prepare(`
      INSERT INTO copy_events (user_id, tenant_id, post_id, run_id, path, format_slug)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId || 'anonymous', tenantId, post_id || null, run_id || null, path || null, format_slug || null);

    return res.json({ ok: true });
  } catch (err) {
    // Silent fail — never interrupt copy
    console.error('[events/copy] Failed to record copy event:', err.message);
    return res.json({ ok: true });
  }
});

module.exports = router;

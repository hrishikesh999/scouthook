'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');

// ---------------------------------------------------------------------------
// POST /api/events/copy
// Feedback loop — one line on the copy button. Fire and forget from client.
// Never blocks the copy action on failure.
// ---------------------------------------------------------------------------
router.post('/copy', async (req, res) => {
  const { post_id, run_id, path, format_slug } = req.body;
  const tenantId = req.tenantId;
  const userId = req.userId;

  if (!userId) {
    console.warn('[events/copy] Missing user_id — event not recorded');
    return res.json({ ok: true });
  }

  try {
    await db.prepare(`
      INSERT INTO copy_events (user_id, tenant_id, post_id, run_id, path, format_slug)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, tenantId, post_id || null, run_id || null, path || null, format_slug || null);

    return res.json({ ok: true });
  } catch (err) {
    // Silent fail — never interrupt copy
    console.error('[events/copy] Failed to record copy event:', err.message);
    return res.json({ ok: true });
  }
});

// ---------------------------------------------------------------------------
// POST /api/events/signup-conversion
// Exactly-once gate for the Meta pixel's CompleteRegistration event.
//
// The client cannot decide this for itself: onboarding.html is reachable again
// whenever someone abandons the wizard and comes back, and browser storage is
// cleared, shared, and duplicated across devices. So the server owns the
// decision. The UPDATE ... WHERE ... IS NULL RETURNING claims the event
// atomically — two concurrent requests cannot both win.
//
// Responds { fire: true } at most once per user, ever. Existing users were
// backfilled as already-fired in migration 079.
// ---------------------------------------------------------------------------
router.post('/signup-conversion', async (req, res) => {
  const userId = req.userId;
  if (!userId) return res.json({ ok: true, fire: false });

  try {
    const row = await db.prepare(`
      UPDATE user_profiles
      SET    signup_conversion_fired_at = now()
      WHERE  user_id = ?
        AND  signup_conversion_fired_at IS NULL
      RETURNING utm_source, utm_campaign, utm_content
    `).get(userId);

    if (!row) return res.json({ ok: true, fire: false });

    return res.json({
      ok:   true,
      fire: true,
      // Echoed back so the pixel event carries the winning angle — this is what
      // makes per-ad-set conversion reporting work in Ads Manager.
      utm_source:   row.utm_source   || null,
      utm_campaign: row.utm_campaign || null,
      utm_content:  row.utm_content  || null,
    });
  } catch (err) {
    // Migration 079 may not have run yet — never fire on an uncertain result,
    // an over-count is far more damaging to ad optimisation than an under-count.
    console.error('[events/signup-conversion] failed:', err.message);
    return res.json({ ok: true, fire: false });
  }
});

module.exports = router;

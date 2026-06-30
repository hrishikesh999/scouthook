'use strict';

const express = require('express');
const router  = express.Router();
const { db }  = require('../db');

// ---------------------------------------------------------------------------
// GET /api/checklist
// Returns onboarding checklist state for the current user.
// All 3 steps are derived from existing tables — no new schema needed.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  if (!req.userId) {
    return res.status(400).json({ ok: false, error: 'missing_user_id' });
  }

  const uid = req.userId;
  const tid = req.tenantId;

  try {
    const userRow = await db.prepare(`
      SELECT display_name FROM user_profiles WHERE user_id = ?
    `).get(uid);

    const profile = await db.prepare(`
      SELECT p.avatar_url, p.writing_samples,
             bvp.brand_description,
             audp.audience_description
      FROM   profiles p
      LEFT JOIN brand_voice_profiles bvp  ON bvp.profile_id = p.id
      LEFT JOIN audience_profiles    audp ON audp.profile_id = p.id
      WHERE  p.workspace_id = ? AND p.is_default = true
    `).get(tid);

    const publishedRow = await db.prepare(`
      SELECT COUNT(*) AS n FROM generated_posts
      WHERE  user_id = ? AND tenant_id = ? AND status IN ('published', 'scheduled')
    `).get(uid, tid);

    const linkedInRow = await db.prepare(`
      SELECT id FROM linkedin_connections
      WHERE  workspace_id = ? AND is_default = true
    `).get(tid);

    const connectUrl = `/api/linkedin/connect?_uid=${encodeURIComponent(uid)}&_tid=${encodeURIComponent(tid)}`;

    const steps = [
      {
        id:    'voice_profile',
        label: 'Complete your voice profile',
        done:  !!(profile?.brand_description && profile?.audience_description && profile?.writing_samples),
        href:  '/profile.html',
      },
      {
        id:    'brand_settings',
        label: 'Update your brand settings',
        done:  !!profile?.avatar_url,
        href:  '/brand.html',
      },
      {
        id:    'linkedin',
        label: 'Connect LinkedIn',
        done:  !!linkedInRow,
        href:  connectUrl,
      },
      {
        id:    'first_publish',
        label: 'Publish your first post',
        done:  (publishedRow?.n ?? 0) > 0,
        href:  '/drafts.html',
      },
    ];

    const completedCount = steps.filter(s => s.done).length;

    return res.json({
      ok:              true,
      display_name:    userRow?.display_name || null,
      steps,
      completed_count: completedCount,
      total:           steps.length,
      all_done:        completedCount === steps.length,
    });
  } catch (err) {
    console.error('[checklist] GET /api/checklist error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

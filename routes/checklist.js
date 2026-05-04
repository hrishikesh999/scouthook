'use strict';

const express = require('express');
const router  = express.Router();
const { db }  = require('../db');

// ---------------------------------------------------------------------------
// GET /api/checklist
// Returns onboarding checklist state for the current user.
// All 5 steps are derived from existing tables — no new schema needed.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  if (!req.userId) {
    return res.status(400).json({ ok: false, error: 'missing_user_id' });
  }

  const uid = req.userId;
  const tid = req.tenantId || 'default';

  try {
    const profile = db.prepare(`
      SELECT display_name, writing_samples, content_niche, brand_name
      FROM   user_profiles
      WHERE  user_id = ? AND tenant_id = ?
    `).get(uid, tid);

    const publishedRow = db.prepare(`
      SELECT COUNT(*) AS n FROM generated_posts
      WHERE  user_id = ? AND tenant_id = ? AND status IN ('published', 'scheduled')
    `).get(uid, tid);

    const linkedInRow = db.prepare(`
      SELECT id FROM linkedin_tokens
      WHERE  user_id = ? AND tenant_id = ?
    `).get(uid, tid);

    const vaultRow = db.prepare(`
      SELECT COUNT(*) AS n FROM vault_documents
      WHERE  user_id = ? AND tenant_id = ?
    `).get(uid, tid);

    const connectUrl = `/api/linkedin/connect?_uid=${encodeURIComponent(uid)}&_tid=${encodeURIComponent(tid)}`;

    const steps = [
      {
        id:    'voice_profile',
        label: 'Complete your voice profile',
        done:  !!(profile?.content_niche),
        href:  '/profile.html',
      },
      {
        id:    'brand_settings',
        label: 'Update your brand settings',
        done:  !!(profile?.brand_name),
        href:  '/brand.html',
      },
      {
        id:    'vault_upload',
        label: 'Upload to Content Vault',
        done:  (vaultRow?.n ?? 0) > 0,
        href:  '/vault.html',
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
      display_name:    profile?.display_name || null,
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

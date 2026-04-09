'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');

// ---------------------------------------------------------------------------
// GET /api/profile/:user_id
// Returns profile fields. Never returns writing_samples or voice_fingerprint.
// ---------------------------------------------------------------------------
router.get('/:user_id', async (req, res) => {
  const { user_id } = req.params;
  const tenantId = req.tenantId;

  const profile = await db
    .prepare('SELECT audience_role, audience_pain, content_niche, contrarian_view, voice_fingerprint, brand_bg, brand_accent, brand_text, brand_name, brand_logo FROM user_profiles WHERE user_id = ? AND tenant_id = ?')
    .get(user_id, tenantId);

  if (!profile) {
    return res.json({ ok: true, profile: null });
  }

  return res.json({
    ok: true,
    profile: {
      audience_role:   profile.audience_role,
      audience_pain:   profile.audience_pain,
      content_niche:   profile.content_niche,
      contrarian_view: profile.contrarian_view,
      has_fingerprint: !!profile.voice_fingerprint,
      brand_bg:        profile.brand_bg     || '#0F1A3C',
      brand_accent:    profile.brand_accent || '#0D7A5F',
      brand_text:      profile.brand_text   || '#F0F4FF',
      brand_name:      profile.brand_name   || null,
      brand_logo:      profile.brand_logo   || null,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/profile
// Save or update voice and audience profile.
// Triggers fingerprint extraction if writing_samples changes.
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const userId = req.userId;
  const tenantId = req.tenantId;

  if (!userId) {
    return res.status(400).json({ ok: false, error: 'missing_user_id' });
  }

  const { writing_samples, contrarian_view, audience_role, audience_pain, content_niche,
          brand_bg, brand_accent, brand_text, brand_name, brand_logo } = req.body;

  if (!audience_role && !audience_pain && !content_niche && !writing_samples && !contrarian_view
      && !brand_bg && !brand_accent && !brand_text && !brand_name && brand_logo === undefined) {
    return res.status(400).json({ ok: false, error: 'no_fields_provided' });
  }

  // Check if writing_samples changed (to decide whether to re-extract fingerprint)
  const existing = await db
    .prepare('SELECT id, writing_samples FROM user_profiles WHERE user_id = ? AND tenant_id = ?')
    .get(userId, tenantId);

  const samplesChanged = writing_samples && writing_samples !== existing?.writing_samples;

  // Upsert profile row
  const result = await db.prepare(`
    INSERT INTO user_profiles (user_id, tenant_id, writing_samples, contrarian_view, audience_role, audience_pain, content_niche, brand_bg, brand_accent, brand_text, brand_name, brand_logo, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, tenant_id) DO UPDATE SET
      writing_samples = COALESCE(excluded.writing_samples, user_profiles.writing_samples),
      contrarian_view = COALESCE(excluded.contrarian_view, user_profiles.contrarian_view),
      audience_role   = COALESCE(excluded.audience_role, user_profiles.audience_role),
      audience_pain   = COALESCE(excluded.audience_pain, user_profiles.audience_pain),
      content_niche   = COALESCE(excluded.content_niche, user_profiles.content_niche),
      brand_bg        = COALESCE(excluded.brand_bg, user_profiles.brand_bg),
      brand_accent    = COALESCE(excluded.brand_accent, user_profiles.brand_accent),
      brand_text      = COALESCE(excluded.brand_text, user_profiles.brand_text),
      brand_name      = COALESCE(excluded.brand_name, user_profiles.brand_name),
      brand_logo      = COALESCE(excluded.brand_logo, user_profiles.brand_logo),
      updated_at      = CURRENT_TIMESTAMP
  RETURNING id
  `).run(userId, tenantId, writing_samples || null, contrarian_view || null, audience_role || null, audience_pain || null, content_niche || null,
         brand_bg || null, brand_accent || null, brand_text || null, brand_name || null, brand_logo || null);

  const profileId = result.lastInsertRowid || existing?.id;

  // Trigger fingerprint extraction async — never block the response on it
  if (samplesChanged) {
    const { extractFingerprint } = require('../services/voiceFingerprint');
    extractFingerprint(writing_samples)
      .then(async fingerprint => {
        if (fingerprint) {
          await db.prepare('UPDATE user_profiles SET voice_fingerprint = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND tenant_id = ?')
            .run(JSON.stringify(fingerprint), userId, tenantId);
        }
      })
      .catch(err => {
        console.error('[profile] Fingerprint extraction failed (non-fatal):', err.message);
      });
  }

  return res.json({ ok: true, profile_id: profileId, fingerprint_updated: samplesChanged });
});

module.exports = router;

'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');

// ---------------------------------------------------------------------------
// GET /api/profile/:user_id
// Returns profile fields. Never returns writing_samples or voice_fingerprint.
// ---------------------------------------------------------------------------
router.get('/:user_id', async (req, res) => {
  // Must match POST /api/profile: use session/header identity (e.g. google:…) — not the
  // URL segment alone. The client often still passes a stale localStorage u_* id in the path
  // while the session user is the real account; that made saves "work" but loads look empty.
  const user_id = req.userId || req.params.user_id;
  const tenantId = req.tenantId;

  if (!user_id) {
    return res.status(400).json({ ok: false, error: 'missing_user_id' });
  }

  const profile = await db
    .prepare('SELECT audience_role, audience_pain, content_niche, contrarian_view, voice_fingerprint, writing_samples, brand_bg, brand_accent, brand_text, brand_name, brand_logo, user_role, onboarding_complete, business_positioning, website_url FROM user_profiles WHERE user_id = ? AND tenant_id = ?')
    .get(user_id, tenantId);

  if (!profile) {
    return res.json({ ok: true, profile: null });
  }

  return res.json({
    ok: true,
    profile: {
      audience_role:       profile.audience_role,
      audience_pain:       profile.audience_pain,
      content_niche:       profile.content_niche,
      contrarian_view:     profile.contrarian_view,
      writing_samples:     profile.writing_samples   || null,
      has_fingerprint:     !!profile.voice_fingerprint,
      brand_bg:            profile.brand_bg     || '#0F1A3C',
      brand_accent:        profile.brand_accent || '#0D7A5F',
      brand_text:          profile.brand_text   || '#F0F4FF',
      brand_name:          profile.brand_name   || null,
      brand_logo:          profile.brand_logo   || null,
      user_role:                    profile.user_role    || null,
      onboarding_complete:          !!profile.onboarding_complete,
      business_positioning:         profile.business_positioning || null,
      website_url:                  profile.website_url  || null,
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
          brand_bg, brand_accent, brand_text, brand_name, brand_logo,
          user_role, onboarding_complete, business_positioning, website_url } = req.body;

  if (!audience_role && !audience_pain && !content_niche && !writing_samples && !contrarian_view
      && !brand_bg && !brand_accent && !brand_text && !brand_name && brand_logo === undefined
      && user_role === undefined && onboarding_complete === undefined && !business_positioning
      && !website_url) {
    return res.status(400).json({ ok: false, error: 'no_fields_provided' });
  }

  // Check what's changing (to decide whether to re-extract fingerprint / rebuild prompt)
  const existing = await db
    .prepare('SELECT id, writing_samples, business_positioning, website_url FROM user_profiles WHERE user_id = ? AND tenant_id = ?')
    .get(userId, tenantId);

  const samplesChanged      = writing_samples && writing_samples !== existing?.writing_samples;
  const positioningChanged  = business_positioning && business_positioning !== existing?.business_positioning;

  // Normalise onboarding_complete: accept 1/true/"1"/"true" → 1, else keep NULL so COALESCE
  // doesn't overwrite an existing 1 with NULL when the field is omitted from the request.
  const obComplete = (onboarding_complete === 1 || onboarding_complete === true
    || onboarding_complete === '1' || onboarding_complete === 'true') ? 1 : null;

  // Upsert profile row
  const result = await db.prepare(`
    INSERT INTO user_profiles (user_id, tenant_id, writing_samples, contrarian_view, audience_role, audience_pain, content_niche, brand_bg, brand_accent, brand_text, brand_name, brand_logo, user_role, onboarding_complete, business_positioning, website_url, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, tenant_id) DO UPDATE SET
      writing_samples     = COALESCE(excluded.writing_samples, user_profiles.writing_samples),
      contrarian_view     = COALESCE(excluded.contrarian_view, user_profiles.contrarian_view),
      audience_role       = COALESCE(excluded.audience_role, user_profiles.audience_role),
      audience_pain       = COALESCE(excluded.audience_pain, user_profiles.audience_pain),
      content_niche       = COALESCE(excluded.content_niche, user_profiles.content_niche),
      brand_bg            = COALESCE(excluded.brand_bg, user_profiles.brand_bg),
      brand_accent        = COALESCE(excluded.brand_accent, user_profiles.brand_accent),
      brand_text          = COALESCE(excluded.brand_text, user_profiles.brand_text),
      brand_name          = COALESCE(excluded.brand_name, user_profiles.brand_name),
      brand_logo          = COALESCE(excluded.brand_logo, user_profiles.brand_logo),
      user_role           = COALESCE(excluded.user_role, user_profiles.user_role),
      onboarding_complete = COALESCE(excluded.onboarding_complete, user_profiles.onboarding_complete),
      business_positioning = COALESCE(excluded.business_positioning, user_profiles.business_positioning),
      website_url         = COALESCE(excluded.website_url, user_profiles.website_url),
      updated_at          = CURRENT_TIMESTAMP
  RETURNING id
  `).run(userId, tenantId, writing_samples || null, contrarian_view || null, audience_role || null, audience_pain || null, content_niche || null,
         brand_bg || null, brand_accent || null, brand_text || null, brand_name || null, brand_logo || null,
         user_role || null, obComplete, business_positioning || null, website_url || null);

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

// ---------------------------------------------------------------------------
// POST /api/profile/extract-website
// Fetches a user's website and extracts voice profile fields via Claude Haiku.
// Used during onboarding to auto-fill niche, audience, and positioning fields.
// ---------------------------------------------------------------------------
router.post('/extract-website', async (req, res) => {
  if (!req.userId) return res.status(401).json({ ok: false, error: 'unauthenticated' });

  const { url } = req.body;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: 'invalid_url' });
  }

  const { extractUrl } = require('../services/vaultMiner');
  const Anthropic = require('@anthropic-ai/sdk');
  const { getSetting } = require('../db');

  try {
    const { text } = await extractUrl(url);
    const truncated = text.slice(0, 4000);

    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) return res.status(500).json({ ok: false, error: 'no_api_key' });

    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Analyze this professional website content and extract positioning for a LinkedIn content tool.

Website content:
${truncated}

Return a JSON object with these fields (concise, 1-2 sentences each):
- content_niche: What this person/business writes or talks about professionally. Frame as "Helping [who] [do what]" if possible.
- audience_role: Who their ideal client is. E.g. "Founders and sales leaders at growing startups"
- audience_pain: The main problem their audience faces (only if clearly inferable)
- contrarian_view: A strong opinion or unconventional stance visible on the site (only if clearly inferable)

Return null for any field you cannot confidently infer. Return only the JSON object, no other text.`,
      }],
    });

    const raw = message.content[0]?.text || '{}';
    let extracted = {};
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      extracted = JSON.parse(match ? match[0] : raw);
    } catch {
      // Malformed JSON — return empty (client falls back silently)
    }

    return res.json({ ok: true, ...extracted });
  } catch (err) {
    console.error('[profile] extract-website error (non-fatal):', err.message);
    return res.json({ ok: false, error: 'extraction_failed' });
  }
});

module.exports = router;

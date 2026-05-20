'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');

// ---------------------------------------------------------------------------
// GET /api/profile/:user_id
// Returns profile fields including voice_fingerprint and voice DNA fields.
// ---------------------------------------------------------------------------
router.get('/:user_id', async (req, res) => {
  // Identity comes exclusively from the authenticated session — never from the URL
  // segment, which the client sends as a convenience but must not be trusted for access control.
  const user_id = req.userId;
  const tenantId = req.tenantId;

  if (!user_id) {
    return res.status(401).json({ ok: false, error: 'unauthenticated' });
  }

  const profile = await db
    .prepare(`SELECT audience_role, audience_pain, content_niche, contrarian_view,
                     voice_fingerprint, writing_samples,
                     brand_bg, brand_accent, brand_text, brand_name, brand_logo,
                     user_role, onboarding_complete, business_positioning, website_url,
                     website_summary, onboarding_q1, onboarding_q2, onboarding_q3,
                     authority_statements, cta_library, content_principles, content_themes,
                     voice_extraction_quality, voice_profile_completion_pct
              FROM user_profiles WHERE user_id = ? AND tenant_id = ?`)
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
      voice_fingerprint:   profile.voice_fingerprint || null,
      brand_bg:            profile.brand_bg     || '#0F1A3C',
      brand_accent:        profile.brand_accent || '#0D7A5F',
      brand_text:          profile.brand_text   || '#F0F4FF',
      brand_name:          profile.brand_name   || null,
      brand_logo:          profile.brand_logo   || null,
      user_role:                    profile.user_role    || null,
      onboarding_complete:          !!profile.onboarding_complete,
      business_positioning:         profile.business_positioning || null,
      website_url:                  profile.website_url  || null,
      // Voice DNA fields (Sprint 2)
      website_summary:              profile.website_summary  || null,
      onboarding_q1:                profile.onboarding_q1   || null,
      onboarding_q2:                profile.onboarding_q2   || null,
      onboarding_q3:                profile.onboarding_q3   || null,
      authority_statements:         profile.authority_statements  || null,
      cta_library:                  profile.cta_library           || null,
      content_principles:           profile.content_principles    || null,
      content_themes:               profile.content_themes        || null,
      voice_extraction_quality:     profile.voice_extraction_quality     || null,
      voice_profile_completion_pct: profile.voice_profile_completion_pct || 0,
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
          user_role, onboarding_complete, business_positioning, website_url, goal,
          // Voice DNA fields (Sprint 2)
          website_summary, website_extracted_at,
          onboarding_q1, onboarding_q2, onboarding_q3, onboarding_q_completed_at,
          onboarding_completed_at,
          authority_statements, cta_library, content_principles, content_themes } = req.body;

  const hasVoiceDNAField = website_summary || onboarding_q1 || onboarding_q2 || onboarding_q3
    || authority_statements || cta_library || content_principles || content_themes;

  if (!audience_role && !audience_pain && !content_niche && !writing_samples && !contrarian_view
      && !brand_bg && !brand_accent && !brand_text && !brand_name && brand_logo === undefined
      && user_role === undefined && onboarding_complete === undefined && !business_positioning
      && !website_url && !goal && !hasVoiceDNAField) {
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
    INSERT INTO user_profiles (
      user_id, tenant_id, writing_samples, contrarian_view, audience_role, audience_pain,
      content_niche, brand_bg, brand_accent, brand_text, brand_name, brand_logo,
      user_role, onboarding_complete, business_positioning, website_url, goal,
      website_summary, website_extracted_at,
      onboarding_q1, onboarding_q2, onboarding_q3, onboarding_q_completed_at,
      onboarding_completed_at,
      authority_statements, cta_library, content_principles, content_themes,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, tenant_id) DO UPDATE SET
      writing_samples         = COALESCE(excluded.writing_samples, user_profiles.writing_samples),
      contrarian_view         = COALESCE(excluded.contrarian_view, user_profiles.contrarian_view),
      audience_role           = COALESCE(excluded.audience_role, user_profiles.audience_role),
      audience_pain           = COALESCE(excluded.audience_pain, user_profiles.audience_pain),
      content_niche           = COALESCE(excluded.content_niche, user_profiles.content_niche),
      brand_bg                = COALESCE(excluded.brand_bg, user_profiles.brand_bg),
      brand_accent            = COALESCE(excluded.brand_accent, user_profiles.brand_accent),
      brand_text              = COALESCE(excluded.brand_text, user_profiles.brand_text),
      brand_name              = COALESCE(excluded.brand_name, user_profiles.brand_name),
      brand_logo              = COALESCE(excluded.brand_logo, user_profiles.brand_logo),
      user_role               = COALESCE(excluded.user_role, user_profiles.user_role),
      onboarding_complete     = COALESCE(excluded.onboarding_complete, user_profiles.onboarding_complete),
      business_positioning    = COALESCE(excluded.business_positioning, user_profiles.business_positioning),
      website_url             = COALESCE(excluded.website_url, user_profiles.website_url),
      goal                    = COALESCE(excluded.goal, user_profiles.goal),
      website_summary         = COALESCE(excluded.website_summary, user_profiles.website_summary),
      website_extracted_at    = COALESCE(excluded.website_extracted_at, user_profiles.website_extracted_at),
      onboarding_q1           = COALESCE(excluded.onboarding_q1, user_profiles.onboarding_q1),
      onboarding_q2           = COALESCE(excluded.onboarding_q2, user_profiles.onboarding_q2),
      onboarding_q3           = COALESCE(excluded.onboarding_q3, user_profiles.onboarding_q3),
      onboarding_q_completed_at = COALESCE(excluded.onboarding_q_completed_at, user_profiles.onboarding_q_completed_at),
      onboarding_completed_at = COALESCE(excluded.onboarding_completed_at, user_profiles.onboarding_completed_at),
      authority_statements    = COALESCE(excluded.authority_statements, user_profiles.authority_statements),
      cta_library             = COALESCE(excluded.cta_library, user_profiles.cta_library),
      content_principles      = COALESCE(excluded.content_principles, user_profiles.content_principles),
      content_themes          = COALESCE(excluded.content_themes, user_profiles.content_themes),
      updated_at              = CURRENT_TIMESTAMP
  RETURNING id
  `).run(
    userId, tenantId,
    writing_samples || null, contrarian_view || null, audience_role || null, audience_pain || null,
    content_niche || null, brand_bg || null, brand_accent || null, brand_text || null,
    brand_name || null, brand_logo || null,
    user_role || null, obComplete, business_positioning || null, website_url || null, goal || null,
    website_summary || null, website_extracted_at || null,
    onboarding_q1 || null, onboarding_q2 || null, onboarding_q3 || null,
    onboarding_q_completed_at || null, onboarding_completed_at || null,
    authority_statements || null, cta_library || null, content_principles || null,
    content_themes || null
  );

  const profileId = result.lastInsertRowid || existing?.id;

  // Trigger fingerprint extraction async — never block the response on it
  if (samplesChanged) {
    const { extractFingerprint } = require('../services/voiceFingerprint');
    const { calculateCompletionPct } = require('../services/voiceExtraction');
    extractFingerprint(writing_samples)
      .then(async fingerprint => {
        if (fingerprint) {
          await db.prepare('UPDATE user_profiles SET voice_fingerprint = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND tenant_id = ?')
            .run(JSON.stringify(fingerprint), userId, tenantId);
          // Recalculate completion pct after fingerprint update
          const updatedProfile = await db.prepare('SELECT * FROM user_profiles WHERE user_id = ? AND tenant_id = ?').get(userId, tenantId);
          const liRow = await db.prepare('SELECT 1 FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?').get(userId, tenantId);
          const pct = calculateCompletionPct(updatedProfile || {}, !!liRow);
          await db.prepare('UPDATE user_profiles SET voice_profile_completion_pct = ? WHERE user_id = ? AND tenant_id = ?').run(pct, userId, tenantId);
        }
      })
      .catch(err => {
        console.error('[profile] Fingerprint extraction failed (non-fatal):', err.message);
      });
  } else if (hasVoiceDNAField) {
    const { extractVoiceDNAFromQA, calculateCompletionPct } = require('../services/voiceExtraction');
    const hasNewQA = onboarding_q1 || onboarding_q2 || onboarding_q3;

    // If any Q&A answers were just saved, run voice DNA extraction (fire-and-forget)
    if (hasNewQA) {
      extractVoiceDNAFromQA(userId, tenantId).catch(err => {
        console.error('[profile] extractVoiceDNAFromQA failed (non-fatal):', err.message);
      });
    }

    // Recalculate completion pct after any voice DNA field update (fire-and-forget)
    Promise.resolve().then(async () => {
      const updatedProfile = await db.prepare('SELECT * FROM user_profiles WHERE user_id = ? AND tenant_id = ?').get(userId, tenantId);
      const liRow = await db.prepare('SELECT 1 FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?').get(userId, tenantId);
      const pct = calculateCompletionPct(updatedProfile || {}, !!liRow);
      await db.prepare('UPDATE user_profiles SET voice_profile_completion_pct = ? WHERE user_id = ? AND tenant_id = ?').run(pct, userId, tenantId);
    }).catch(() => {});
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

Return a JSON object with these fields (concise):
- content_niche: What this person/business writes or talks about professionally. 2-4 word label. E.g. "B2B SaaS growth" or "executive leadership coaching"
- audience_role: Who their ideal client is. E.g. "Founders and sales leaders at growing startups"
- audience_pain: The main problem their audience faces (only if clearly inferable)
- contrarian_view: A strong opinion or unconventional stance visible on the site (only if clearly inferable)
- business_positioning: A single sentence — what this person does and for whom. E.g. "I help DTC founders scale from $1M to $10M revenue without hiring a big agency." (only if clearly inferable from the site)

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

    // Build website_summary — a narrative paragraph combining the extracted fields.
    // Distinct from business_positioning (user-entered). Stored for voice extraction use.
    const summaryParts = [];
    if (extracted.content_niche) summaryParts.push(extracted.content_niche);
    if (extracted.audience_pain) summaryParts.push(`Their audience struggles with: ${extracted.audience_pain}`);
    if (extracted.contrarian_view) summaryParts.push(extracted.contrarian_view);
    const website_summary = summaryParts.join(' ') || null;

    // Persist website_summary to DB (fire-and-forget — response does not wait)
    if (website_summary && req.userId && req.tenantId) {
      db.prepare(
        `UPDATE user_profiles SET website_summary = ?, website_extracted_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND tenant_id = ?`
      ).run(website_summary, req.userId, req.tenantId).catch(() => {});
    }

    return res.json({ ok: true, ...extracted, website_summary });
  } catch (err) {
    console.error('[profile] extract-website error (non-fatal):', err.message);
    return res.json({ ok: false, error: 'extraction_failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/profile/suggest-themes
// Uses Haiku to suggest 4-6 content themes from the user's profile data.
// Used by the Voice Profile Wizard Stage 1 to seed the themes chip picker.
// ---------------------------------------------------------------------------
router.post('/suggest-themes', async (req, res) => {
  if (!req.userId) return res.status(401).json({ ok: false, error: 'unauthenticated' });

  const Anthropic = require('@anthropic-ai/sdk');
  const { getSetting } = require('../db');

  try {
    const profile = await db.prepare(
      `SELECT content_niche, website_summary, onboarding_q1, onboarding_q2, onboarding_q3, audience_role
       FROM user_profiles WHERE user_id = ? AND tenant_id = ?`
    ).get(req.userId, req.tenantId);

    if (!profile) return res.json({ ok: true, themes: [] });

    const context = [
      profile.content_niche   && `Niche: ${profile.content_niche}`,
      profile.website_summary && `Website summary: ${profile.website_summary}`,
      profile.audience_role   && `Audience: ${profile.audience_role}`,
      profile.onboarding_q1  && `POV (Q1): ${profile.onboarding_q1}`,
      profile.onboarding_q2  && `Voice (Q2): ${profile.onboarding_q2}`,
      profile.onboarding_q3  && `Proof (Q3): ${profile.onboarding_q3}`,
    ].filter(Boolean).join('\n');

    if (!context.trim()) return res.json({ ok: true, themes: [] });

    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) return res.json({ ok: true, themes: [] });

    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Based on this professional's profile, suggest 5-6 content themes for their LinkedIn posts.

${context}

Rules:
- Each theme: 2-5 words, specific to their niche (not generic like "leadership" or "mindset")
- Themes should represent distinct content angles they can write about repeatedly
- No overlap between themes

Return ONLY a JSON array of strings:
["Theme one", "Theme two", ...]`,
      }],
    });

    const raw = message.content[0]?.text || '[]';
    let themes = [];
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      themes = JSON.parse(match ? match[0] : raw);
      if (!Array.isArray(themes)) themes = [];
      themes = themes.filter(t => typeof t === 'string' && t.trim()).slice(0, 6);
    } catch { /* return empty on parse failure */ }

    return res.json({ ok: true, themes });
  } catch (err) {
    console.error('[profile] suggest-themes error:', err.message);
    return res.json({ ok: true, themes: [] }); // non-fatal: return empty
  }
});

// ---------------------------------------------------------------------------
// POST /api/profile/generate-positioning
// Generates a one-sentence positioning statement from niche + audience + pain.
// Returns the suggestion — does NOT save to DB. Client saves via POST /api/profile.
// ---------------------------------------------------------------------------
router.post('/generate-positioning', async (req, res) => {
  if (!req.userId) return res.status(401).json({ ok: false, error: 'unauthenticated' });

  const { content_niche, audience_role, audience_pain } = req.body;
  if (!content_niche && !audience_role) {
    return res.status(400).json({ ok: false, error: 'missing_fields', message: 'Provide at least content_niche or audience_role' });
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const { getSetting } = require('../db');

  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) return res.status(500).json({ ok: false, error: 'no_api_key' });

    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `Generate a one-sentence LinkedIn positioning statement.

Niche: ${content_niche || 'not specified'}
Audience: ${audience_role || 'not specified'}
Their pain: ${audience_pain || 'not specified'}

Format: "I help [specific audience] [achieve specific result] [without/by doing X]."
Be concrete — use the exact audience and niche provided. No preamble, no quotes around the sentence.`,
      }],
    });

    const positioning = (message.content[0]?.text || '').trim();
    return res.json({ ok: true, business_positioning: positioning });
  } catch (err) {
    console.error('[profile] generate-positioning error:', err.message);
    return res.status(500).json({ ok: false, error: 'generation_failed' });
  }
});

module.exports = router;

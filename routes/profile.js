'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');

// ---------------------------------------------------------------------------
// GET /api/profile/:user_id?
// Assembles profile from three tables: user_profiles (identity), workspaces
// (brand settings), profiles (voice DNA + positioning). Returns same shape as
// the old single-table response so the frontend needs no changes.
// ---------------------------------------------------------------------------
router.get('/:user_id?', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;

  const [userRow, wsRow, profileRow] = await Promise.all([
    db.prepare('SELECT user_role, email, display_name FROM user_profiles WHERE user_id = ?').get(userId),
    db.prepare('SELECT brand_name, brand_bg, brand_accent, brand_text, brand_logo FROM workspaces WHERE id = ?').get(tenantId),
    db.prepare(`
      SELECT id, audience_role, audience_pain, content_niche, contrarian_view,
             voice_fingerprint, writing_samples, onboarding_complete,
             business_positioning, website_url, website_summary,
             onboarding_q1, onboarding_q2, onboarding_q3,
             authority_statements, cta_library, content_principles, content_themes,
             voice_extraction_quality, voice_profile_completion_pct,
             input_examples, voice_refinements, content_pillars,
             user_archetype_preference
      FROM profiles WHERE workspace_id = ? AND is_default = true
    `).get(tenantId),
  ]);

  if (!profileRow) {
    return res.json({ ok: true, profile: null });
  }

  return res.json({
    ok: true,
    profile: {
      audience_role:                profileRow.audience_role,
      audience_pain:                profileRow.audience_pain,
      content_niche:                profileRow.content_niche,
      contrarian_view:              profileRow.contrarian_view,
      writing_samples:              profileRow.writing_samples   || null,
      has_fingerprint:              !!profileRow.voice_fingerprint,
      voice_fingerprint:            profileRow.voice_fingerprint || null,
      brand_bg:                     wsRow?.brand_bg     || '#0F1A3C',
      brand_accent:                 wsRow?.brand_accent || '#0D7A5F',
      brand_text:                   wsRow?.brand_text   || '#F0F4FF',
      brand_name:                   wsRow?.brand_name   || null,
      brand_logo:                   wsRow?.brand_logo   || null,
      user_role:                    userRow?.user_role  || null,
      onboarding_complete:          !!profileRow.onboarding_complete,
      business_positioning:         profileRow.business_positioning || null,
      website_url:                  profileRow.website_url          || null,
      website_summary:              profileRow.website_summary      || null,
      onboarding_q1:                profileRow.onboarding_q1        || null,
      onboarding_q2:                profileRow.onboarding_q2        || null,
      onboarding_q3:                profileRow.onboarding_q3        || null,
      authority_statements:         profileRow.authority_statements || null,
      cta_library:                  profileRow.cta_library          || null,
      content_principles:           profileRow.content_principles   || null,
      content_themes:               profileRow.content_themes       || null,
      voice_extraction_quality:     profileRow.voice_extraction_quality     || null,
      voice_profile_completion_pct: profileRow.voice_profile_completion_pct || 0,
      input_examples:               profileRow.input_examples               || null,
      voice_refinements:            profileRow.voice_refinements            || null,
      content_pillars:              profileRow.content_pillars              || null,
      user_archetype_preference:    profileRow.user_archetype_preference    || null,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/profile
// Routes each field to the correct table:
//   user_role              → user_profiles  (identity — per person, not per workspace)
//   brand_name/bg/accent/… → workspaces     (brand settings)
//   everything else        → profiles       (voice DNA + positioning)
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;

  const {
    writing_samples, contrarian_view, audience_role, audience_pain, content_niche,
    brand_bg, brand_accent, brand_text, brand_name, brand_logo,
    user_role, onboarding_complete, business_positioning, website_url, goal,
    website_summary, website_extracted_at,
    onboarding_q1, onboarding_q2, onboarding_q3, onboarding_q_completed_at,
    onboarding_completed_at,
    authority_statements, cta_library, content_principles, content_themes,
    content_pillars,
  } = req.body;

  const hasVoiceDNAField = website_summary || onboarding_q1 || onboarding_q2 || onboarding_q3
    || authority_statements || cta_library || content_principles || content_themes;

  if (!audience_role && !audience_pain && !content_niche && !writing_samples && !contrarian_view
      && !brand_bg && !brand_accent && !brand_text && !brand_name && brand_logo === undefined
      && user_role === undefined && onboarding_complete === undefined && !business_positioning
      && !website_url && !goal && !hasVoiceDNAField && !content_pillars) {
    return res.status(400).json({ ok: false, error: 'no_fields_provided' });
  }

  // Fetch brand profile — needed for change detection and profileId routing
  const brandProfile = await db.prepare(
    'SELECT id, writing_samples, business_positioning, onboarding_complete FROM profiles WHERE workspace_id = ? AND is_default = true'
  ).get(tenantId);

  if (!brandProfile) {
    return res.status(500).json({ ok: false, error: 'no_brand_profile' });
  }

  const profileId      = brandProfile.id;
  const samplesChanged = writing_samples && writing_samples !== brandProfile.writing_samples;

  // Normalise onboarding_complete to boolean (PostgreSQL) or null (preserve existing via COALESCE)
  const obComplete = (onboarding_complete === 1 || onboarding_complete === true
    || onboarding_complete === '1' || onboarding_complete === 'true') ? true : null;

  // 1. Identity → user_profiles (no tenant_id column post-migration)
  if (user_role !== undefined && user_role !== null) {
    await db.prepare(
      'UPDATE user_profiles SET user_role = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'
    ).run(user_role, userId);
  }

  // 2. Brand settings → workspaces
  const hasBrandField = brand_name !== undefined || brand_bg || brand_accent || brand_text
    || brand_logo !== undefined;
  if (hasBrandField) {
    await db.prepare(`
      UPDATE workspaces SET
        brand_name   = COALESCE(?, brand_name),
        brand_bg     = COALESCE(?, brand_bg),
        brand_accent = COALESCE(?, brand_accent),
        brand_text   = COALESCE(?, brand_text),
        brand_logo   = COALESCE(?, brand_logo),
        updated_at   = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      brand_name || null, brand_bg || null, brand_accent || null, brand_text || null,
      brand_logo !== undefined ? (brand_logo || null) : null,
      tenantId
    );
  }

  // 3. Voice DNA + positioning → profiles (COALESCE preserves fields not in this request)
  await db.prepare(`
    UPDATE profiles SET
      writing_samples           = COALESCE(?, writing_samples),
      contrarian_view           = COALESCE(?, contrarian_view),
      audience_role             = COALESCE(?, audience_role),
      audience_pain             = COALESCE(?, audience_pain),
      content_niche             = COALESCE(?, content_niche),
      business_positioning      = COALESCE(?, business_positioning),
      website_url               = COALESCE(?, website_url),
      goal                      = COALESCE(?, goal),
      website_summary           = COALESCE(?, website_summary),
      website_extracted_at      = COALESCE(?, website_extracted_at),
      onboarding_q1             = COALESCE(?, onboarding_q1),
      onboarding_q2             = COALESCE(?, onboarding_q2),
      onboarding_q3             = COALESCE(?, onboarding_q3),
      onboarding_q_completed_at = COALESCE(?, onboarding_q_completed_at),
      onboarding_completed_at   = COALESCE(?, onboarding_completed_at),
      authority_statements      = COALESCE(?, authority_statements),
      cta_library               = COALESCE(?, cta_library),
      content_principles        = COALESCE(?, content_principles),
      content_themes            = COALESCE(?, content_themes),
      content_pillars           = COALESCE(?, content_pillars),
      onboarding_complete       = COALESCE(?, onboarding_complete),
      updated_at                = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    writing_samples || null, contrarian_view || null, audience_role || null, audience_pain || null,
    content_niche || null, business_positioning || null, website_url || null, goal || null,
    website_summary || null, website_extracted_at || null,
    onboarding_q1 || null, onboarding_q2 || null, onboarding_q3 || null,
    onboarding_q_completed_at || null, onboarding_completed_at || null,
    authority_statements || null, cta_library || null, content_principles || null,
    content_themes || null, content_pillars || null,
    obComplete,
    profileId,
  );

  // 4a. Fingerprint extraction when writing_samples changes (fire-and-forget)
  if (samplesChanged) {
    const { seedPhrasesFromWritingSamples } = require('../services/writingSampleSeeder');
    seedPhrasesFromWritingSamples(userId, tenantId, writing_samples)
      .then(phrases => {
        if (phrases.length) {
          return db.prepare(
            'UPDATE profiles SET writing_sample_phrases = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
          ).run(JSON.stringify(phrases), profileId);
        }
      })
      .catch(err => console.error('[profile] Phrase seeding failed (non-fatal):', err.message));

    const { extractFingerprint } = require('../services/voiceFingerprint');
    const { calculateCompletionPct } = require('../services/voiceExtraction');
    extractFingerprint(writing_samples)
      .then(async fingerprint => {
        if (fingerprint) {
          await db.prepare(
            'UPDATE profiles SET voice_fingerprint = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
          ).run(JSON.stringify(fingerprint), profileId);
          const updatedProfile = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
          const liRow = await db.prepare(
            'SELECT 1 FROM linkedin_connections WHERE workspace_id = ? AND is_default = true'
          ).get(tenantId);
          const pct = calculateCompletionPct(updatedProfile || {}, !!liRow);
          await db.prepare(
            'UPDATE profiles SET voice_profile_completion_pct = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
          ).run(pct, profileId);
        }
      })
      .catch(err => console.error('[profile] Fingerprint extraction failed (non-fatal):', err.message));
  } else if (hasVoiceDNAField) {
    // 4b. Voice DNA extraction when Q&A answers arrive (fire-and-forget)
    const { extractVoiceDNAFromQA, calculateCompletionPct } = require('../services/voiceExtraction');
    const hasNewQA = onboarding_q1 || onboarding_q2 || onboarding_q3;
    if (hasNewQA) {
      extractVoiceDNAFromQA(profileId).catch(err =>
        console.error('[profile] extractVoiceDNAFromQA failed (non-fatal):', err.message)
      );
    }
    Promise.resolve().then(async () => {
      const updatedProfile = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
      const liRow = await db.prepare(
        'SELECT 1 FROM linkedin_connections WHERE workspace_id = ? AND is_default = true'
      ).get(tenantId);
      const pct = calculateCompletionPct(updatedProfile || {}, !!liRow);
      await db.prepare(
        'UPDATE profiles SET voice_profile_completion_pct = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(pct, profileId);
    }).catch(() => {});
  }

  // 5. Onboarding completion: stamp timestamp + fire voice extraction jobs (fire-and-forget)
  // Service signatures change to (profileId, opts) in Sprint 2; calls fail silently until then.
  if (obComplete === true && !brandProfile.onboarding_complete) {
    await db.prepare(
      'UPDATE profiles SET onboarding_completed_at = CURRENT_TIMESTAMP WHERE id = ? AND onboarding_completed_at IS NULL'
    ).run(profileId);

    const { extractVoiceDNAFromQA } = require('../services/voiceExtraction');
    const { generateInputExamples, generateContentPillars } = require('../services/inputCoach');
    const userRow = await db.prepare('SELECT user_role FROM user_profiles WHERE user_id = ?').get(userId);
    const userRole = userRow?.user_role || null;

    extractVoiceDNAFromQA(profileId, { userRole }).catch(err =>
      console.error('[profile] extractVoiceDNAFromQA failed (non-fatal):', err.message)
    );
    generateInputExamples(profileId).catch(err =>
      console.error('[profile] generateInputExamples failed (non-fatal):', err.message)
    );
    generateContentPillars(profileId).catch(err =>
      console.error('[profile] generateContentPillars failed (non-fatal):', err.message)
    );
  }

  return res.json({ ok: true, profile_id: profileId, fingerprint_updated: samplesChanged });
});

// ---------------------------------------------------------------------------
// POST /api/profile/extract-website
// Fetches a user's website and extracts voice profile fields via Claude Haiku.
// Used during onboarding to auto-fill niche, audience, and positioning fields.
// ---------------------------------------------------------------------------
router.post('/extract-website', async (req, res) => {
  const { url } = req.body;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: 'invalid_url' });
  }

  const { extractUrl, extractAboutPage } = require('../services/vaultMiner');
  const Anthropic = require('@anthropic-ai/sdk');
  const { getSetting } = require('../db');

  try {
    const [aboutText, { text: homepageText }] = await Promise.all([
      extractAboutPage(url).catch(() => null),
      extractUrl(url),
    ]);
    const primaryText = (aboutText && aboutText.length > 300) ? aboutText : homepageText;
    const truncated = primaryText.slice(0, 4000);

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

    const summaryParts = [];
    if (extracted.content_niche) summaryParts.push(extracted.content_niche);
    if (extracted.audience_pain) summaryParts.push(`Their audience struggles with: ${extracted.audience_pain}`);
    if (extracted.contrarian_view) summaryParts.push(extracted.contrarian_view);
    const website_summary = summaryParts.join(' ') || null;

    // Persist website_summary to workspace's default profile (fire-and-forget)
    if (website_summary) {
      db.prepare(
        `UPDATE profiles SET website_summary = ?, website_extracted_at = CURRENT_TIMESTAMP
         WHERE workspace_id = ? AND is_default = true`
      ).run(website_summary, req.tenantId).catch(() => {});
    }

    // Crawl blog articles for richer voice signal (fire-and-forget)
    const { extractBlogPosts } = require('../services/vaultMiner');
    extractBlogPosts(url)
      .then(articlesText => {
        if (articlesText && articlesText.trim().length > 200) {
          return db.prepare(
            'UPDATE profiles SET website_articles_text = ? WHERE workspace_id = ? AND is_default = true'
          ).run(articlesText.trim(), req.tenantId);
        }
      })
      .catch(err => console.warn('[profile] extractBlogPosts failed (non-fatal):', err.message));

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
  const Anthropic = require('@anthropic-ai/sdk');
  const { getSetting } = require('../db');

  try {
    const profile = await db.prepare(`
      SELECT content_niche, website_summary, onboarding_q1, onboarding_q2, onboarding_q3, audience_role
      FROM profiles WHERE workspace_id = ? AND is_default = true
    `).get(req.tenantId);

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
    return res.json({ ok: true, themes: [] });
  }
});

// ---------------------------------------------------------------------------
// POST /api/profile/generate-positioning
// Generates a one-sentence positioning statement from niche + audience + pain.
// Returns the suggestion — does NOT save to DB. Client saves via POST /api/profile.
// ---------------------------------------------------------------------------
router.post('/generate-positioning', async (req, res) => {
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

// ---------------------------------------------------------------------------
// POST /api/profile/generate-input-examples
// Generates niche-specific textarea placeholder examples and stores them.
// Called manually (e.g. from settings) or auto-triggered at onboarding completion.
// ---------------------------------------------------------------------------
router.post('/generate-input-examples', async (req, res) => {
  try {
    const brandProfile = await db.prepare(
      'SELECT id FROM profiles WHERE workspace_id = ? AND is_default = true'
    ).get(req.tenantId);
    if (!brandProfile) return res.status(404).json({ ok: false, error: 'no_brand_profile' });

    const { generateInputExamples } = require('../services/inputCoach');
    await generateInputExamples(brandProfile.id);
    const row = await db.prepare(
      'SELECT input_examples FROM profiles WHERE id = ?'
    ).get(brandProfile.id);
    return res.json({ ok: true, input_examples: row?.input_examples || null });
  } catch (err) {
    console.error('[profile] generate-input-examples error:', err.message);
    return res.status(500).json({ ok: false, error: 'generation_failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/profile/generate-content-pillars
// Generates content pillars from niche + onboarding Q&A and stores them.
// Called at onboarding completion or manually from settings.
// ---------------------------------------------------------------------------
router.post('/generate-content-pillars', async (req, res) => {
  try {
    const brandProfile = await db.prepare(
      'SELECT id FROM profiles WHERE workspace_id = ? AND is_default = true'
    ).get(req.tenantId);
    if (!brandProfile) return res.status(404).json({ ok: false, error: 'no_brand_profile' });

    const { generateContentPillars } = require('../services/inputCoach');
    await generateContentPillars(brandProfile.id);
    const row = await db.prepare(
      'SELECT content_pillars FROM profiles WHERE id = ?'
    ).get(brandProfile.id);
    return res.json({ ok: true, content_pillars: row?.content_pillars || null });
  } catch (err) {
    console.error('[profile] generate-content-pillars error:', err.message);
    return res.status(500).json({ ok: false, error: 'generation_failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/profile/:id/voice-setup
// Saves writing samples + Q&A for a person-type profile and fires voice
// extraction jobs. Called by the mini-onboarding modal shown immediately
// after a personal LinkedIn account is connected.
// ---------------------------------------------------------------------------
router.post('/:id/voice-setup', async (req, res) => {
  const profileId = Number(req.params.id);
  const tenantId  = req.tenantId;

  if (!Number.isFinite(profileId) || profileId <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_profile_id' });
  }

  const { writingSamples, q1, q2 } = req.body;
  if (!writingSamples && !q1 && !q2) {
    return res.status(400).json({ ok: false, error: 'no_fields_provided' });
  }

  try {
    const profile = await db.prepare(
      'SELECT id FROM profiles WHERE id = ? AND workspace_id = ?'
    ).get(profileId, tenantId);

    if (!profile) {
      return res.status(404).json({ ok: false, error: 'profile_not_found' });
    }

    await db.prepare(`
      UPDATE profiles SET
        writing_samples = COALESCE(?, writing_samples),
        onboarding_q1   = COALESCE(?, onboarding_q1),
        onboarding_q2   = COALESCE(?, onboarding_q2),
        updated_at      = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(writingSamples || null, q1 || null, q2 || null, profileId);

    const { extractVoiceDNAFromQA } = require('../services/voiceExtraction');
    const { generateContentPillars, generateInputExamples } = require('../services/inputCoach');

    extractVoiceDNAFromQA(profileId).catch(err =>
      console.error('[profile/voice-setup] extractVoiceDNAFromQA failed:', err.message)
    );
    generateContentPillars(profileId).catch(err =>
      console.error('[profile/voice-setup] generateContentPillars failed:', err.message)
    );
    generateInputExamples(profileId).catch(err =>
      console.error('[profile/voice-setup] generateInputExamples failed:', err.message)
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('[profile/voice-setup] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

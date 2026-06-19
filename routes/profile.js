'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Full profile SELECT — joins brand_voice_profiles and audience_profiles so
// callers get a flat merged object identical in shape to the old single-table
// response (no downstream changes needed).
const FULL_PROFILE_SQL = `
  SELECT p.id, p.display_name, p.avatar_url,
         bvp.brand_description, bvp.brand_industry, bvp.brand_personality_traits, bvp.brand_emotional_tone,
         bvp.elevator_main_result, bvp.elevator_mechanism, bvp.brand_archetype, bvp.brand_core_beliefs,
         bvp.brand_phrases_to_use, bvp.brand_story_origin, bvp.brand_voice_profile_json,
         audp.audience_description, audp.audience_goals, audp.audience_obstacles,
         audp.audience_core_beliefs_market, audp.audience_buying_stage, audp.audience_market_sophistication,
         audp.audience_profile_json,
         p.voice_fingerprint, p.writing_samples, p.onboarding_complete,
         p.website_url, p.website_summary,
         p.onboarding_q2, p.onboarding_q3,
         p.authority_statements, p.cta_library, p.content_principles, p.content_themes,
         p.voice_extraction_quality, p.voice_profile_completion_pct,
         p.input_examples, p.voice_refinements, p.content_pillars,
         p.user_archetype_preference
  FROM profiles p
  LEFT JOIN brand_voice_profiles bvp ON bvp.profile_id = p.id
  LEFT JOIN audience_profiles    audp ON audp.profile_id = p.id
`;

// Fetch full merged profile row by profile id (used internally for completeness checks).
function getFullProfileById(profileId) {
  return db.prepare(`${FULL_PROFILE_SQL} WHERE p.id = ?`).get(profileId);
}

// UPSERT a set of brand voice fields for a given profile.
// Incoming null values are ignored (COALESCE preserves existing DB value).
async function upsertBrandVoice(profileId, fields) {
  const cols = Object.keys(fields).filter(k => fields[k] !== undefined);
  if (cols.length === 0) return;
  const placeholders = cols.map(() => '?').join(', ');
  const setClauses   = cols.map(c => `${c} = COALESCE(EXCLUDED.${c}, brand_voice_profiles.${c})`).join(', ');
  await db.prepare(`
    INSERT INTO brand_voice_profiles (profile_id, ${cols.join(', ')})
    VALUES (?, ${placeholders})
    ON CONFLICT (profile_id) DO UPDATE SET ${setClauses}, updated_at = CURRENT_TIMESTAMP
  `).run(profileId, ...cols.map(c => fields[c]));
}

// UPSERT a set of audience fields for a given profile.
async function upsertAudienceProfile(profileId, fields) {
  const cols = Object.keys(fields).filter(k => fields[k] !== undefined);
  if (cols.length === 0) return;
  const placeholders = cols.map(() => '?').join(', ');
  const setClauses   = cols.map(c => `${c} = COALESCE(EXCLUDED.${c}, audience_profiles.${c})`).join(', ');
  await db.prepare(`
    INSERT INTO audience_profiles (profile_id, ${cols.join(', ')})
    VALUES (?, ${placeholders})
    ON CONFLICT (profile_id) DO UPDATE SET ${setClauses}, updated_at = CURRENT_TIMESTAMP
  `).run(profileId, ...cols.map(c => fields[c]));
}

// ---------------------------------------------------------------------------
// GET /api/profile/:user_id?
// Assembles profile from: user_profiles (identity), workspaces (brand settings),
// profiles + brand_voice_profiles + audience_profiles (voice DNA). Returns the
// same flat shape as before — consumers need no changes.
// ---------------------------------------------------------------------------
router.get('/:user_id?', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;

  const requestedProfileId = req.query.profile_id ? Number(req.query.profile_id) : null;

  const profileQueryPromise = requestedProfileId
    ? db.prepare(`${FULL_PROFILE_SQL} WHERE p.id = ? AND p.workspace_id = ?`).get(requestedProfileId, tenantId)
    : db.prepare(`${FULL_PROFILE_SQL} WHERE p.workspace_id = ? AND p.is_default = true`).get(tenantId);

  let userRow, wsRow, profileRow;
  try {
    [userRow, wsRow, profileRow] = await Promise.all([
      db.prepare('SELECT user_role, email, display_name FROM user_profiles WHERE user_id = ?').get(userId),
      db.prepare('SELECT brand_name, brand_bg, brand_accent, brand_text, brand_logo, brand_font_heading, brand_font_body, brand_secondary_bg, brand_secondary_text FROM workspaces WHERE id = ?').get(tenantId),
      profileQueryPromise,
    ]);
  } catch (err) {
    console.error('[profile/get] DB error:', err.message);
    return res.status(500).json({ ok: false, error: 'db_error' });
  }

  if (!profileRow) {
    return res.json({ ok: true, profile: null });
  }

  return res.json({
    ok: true,
    profile: {
      id:                           profileRow.id,
      display_name:                 profileRow.display_name   || null,
      avatar_url:                   profileRow.avatar_url     || null,
      // Brand Voice
      brand_description:            profileRow.brand_description        || null,
      brand_industry:               profileRow.brand_industry           || null,
      brand_personality_traits:     profileRow.brand_personality_traits || null,
      brand_emotional_tone:         profileRow.brand_emotional_tone     || null,
      elevator_main_result:         profileRow.elevator_main_result     || null,
      elevator_mechanism:           profileRow.elevator_mechanism       || null,
      brand_archetype:              profileRow.brand_archetype          || null,
      brand_core_beliefs:           profileRow.brand_core_beliefs       || null,
      brand_phrases_to_use:         profileRow.brand_phrases_to_use     || null,
      brand_story_origin:           profileRow.brand_story_origin       || null,
      brand_voice_profile_json:     profileRow.brand_voice_profile_json || null,
      // Audience
      audience_description:         profileRow.audience_description         || null,
      audience_goals:               profileRow.audience_goals               || null,
      audience_obstacles:           profileRow.audience_obstacles           || null,
      audience_core_beliefs_market: profileRow.audience_core_beliefs_market || null,
      audience_buying_stage:        profileRow.audience_buying_stage        || null,
      audience_market_sophistication: profileRow.audience_market_sophistication || null,
      audience_profile_json:        profileRow.audience_profile_json        || null,
      // Voice DNA
      writing_samples:              profileRow.writing_samples   || null,
      has_fingerprint:              !!profileRow.voice_fingerprint,
      voice_fingerprint:            profileRow.voice_fingerprint || null,
      brand_bg:                     wsRow?.brand_bg             || '#0F1A3C',
      brand_accent:                 wsRow?.brand_accent         || '#0D7A5F',
      brand_text:                   wsRow?.brand_text           || '#F0F4FF',
      brand_name:                   wsRow?.brand_name           || null,
      brand_logo:                   wsRow?.brand_logo           || null,
      brand_font_heading:           wsRow?.brand_font_heading   || null,
      brand_font_body:              wsRow?.brand_font_body      || null,
      brand_secondary_bg:           wsRow?.brand_secondary_bg   || null,
      brand_secondary_text:         wsRow?.brand_secondary_text || null,
      user_role:                    userRow?.user_role  || null,
      onboarding_complete:          !!profileRow.onboarding_complete,
      website_url:                  profileRow.website_url          || null,
      website_summary:              profileRow.website_summary      || null,
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
//   user_role              → user_profiles
//   brand_name/bg/…        → workspaces
//   brand_*/elevator_*     → brand_voice_profiles (UPSERT)
//   audience_*             → audience_profiles    (UPSERT)
//   everything else        → profiles
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;

  const {
    writing_samples,
    brand_description, brand_industry, brand_personality_traits, brand_emotional_tone,
    elevator_main_result, elevator_mechanism, brand_archetype, brand_core_beliefs,
    brand_phrases_to_use, brand_story_origin, brand_voice_profile_json,
    audience_description, audience_goals, audience_obstacles,
    audience_core_beliefs_market, audience_buying_stage, audience_market_sophistication,
    audience_profile_json,
    brand_bg, brand_accent, brand_text, brand_name, brand_logo,
    brand_font_heading, brand_font_body, brand_secondary_bg, brand_secondary_text,
    user_role, onboarding_complete, website_url,
    website_summary, website_extracted_at,
    onboarding_q2, onboarding_q3, onboarding_q_completed_at,
    onboarding_completed_at,
    authority_statements, cta_library, content_principles, content_themes,
    content_pillars,
  } = req.body;

  const hasVoiceDNAField = website_summary || onboarding_q2 || onboarding_q3
    || authority_statements || cta_library || content_principles || content_themes
    || content_pillars;

  const hasBrandVoiceField = brand_description || brand_industry || brand_personality_traits
    || brand_emotional_tone || elevator_main_result || elevator_mechanism || brand_archetype
    || brand_core_beliefs || brand_phrases_to_use || brand_story_origin || brand_voice_profile_json;

  const hasAudienceField = audience_description || audience_goals || audience_obstacles
    || audience_core_beliefs_market || audience_buying_stage || audience_market_sophistication
    || audience_profile_json;

  if (!writing_samples && !hasBrandVoiceField && !hasAudienceField
      && !brand_bg && !brand_accent && !brand_text && !brand_name && brand_logo === undefined
      && brand_font_heading === undefined && brand_font_body === undefined
      && brand_secondary_bg === undefined && brand_secondary_text === undefined
      && user_role === undefined && onboarding_complete === undefined
      && !website_url && !hasVoiceDNAField && !content_pillars) {
    return res.status(400).json({ ok: false, error: 'no_fields_provided' });
  }

  const brandProfile = await db.prepare(
    'SELECT id, writing_samples, onboarding_complete FROM profiles WHERE workspace_id = ? AND is_default = true'
  ).get(tenantId);

  if (!brandProfile) {
    return res.status(500).json({ ok: false, error: 'no_brand_profile' });
  }

  const profileId      = brandProfile.id;
  const samplesChanged = writing_samples && writing_samples !== brandProfile.writing_samples;

  const obComplete = (onboarding_complete === 1 || onboarding_complete === true
    || onboarding_complete === '1' || onboarding_complete === 'true') ? true : null;

  // 1. Identity → user_profiles
  if (user_role !== undefined && user_role !== null) {
    await db.prepare(
      'UPDATE user_profiles SET user_role = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'
    ).run(user_role, userId);
  }

  // 2. Brand settings → workspaces
  const hasBrandField = brand_name !== undefined || brand_bg || brand_accent || brand_text
    || brand_logo !== undefined
    || brand_font_heading !== undefined || brand_font_body !== undefined
    || brand_secondary_bg !== undefined || brand_secondary_text !== undefined;
  if (hasBrandField) {
    await db.prepare(`
      UPDATE workspaces SET
        brand_name           = COALESCE(?, brand_name),
        brand_bg             = COALESCE(?, brand_bg),
        brand_accent         = COALESCE(?, brand_accent),
        brand_text           = COALESCE(?, brand_text),
        brand_logo           = COALESCE(?, brand_logo),
        brand_font_heading   = COALESCE(?, brand_font_heading),
        brand_font_body      = COALESCE(?, brand_font_body),
        brand_secondary_bg   = COALESCE(?, brand_secondary_bg),
        brand_secondary_text = COALESCE(?, brand_secondary_text),
        updated_at           = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      brand_name || null, brand_bg || null, brand_accent || null, brand_text || null,
      brand_logo           !== undefined ? (brand_logo           || null) : null,
      brand_font_heading   !== undefined ? (brand_font_heading   || null) : null,
      brand_font_body      !== undefined ? (brand_font_body      || null) : null,
      brand_secondary_bg   !== undefined ? (brand_secondary_bg   || null) : null,
      brand_secondary_text !== undefined ? (brand_secondary_text || null) : null,
      tenantId
    );
  }

  // 3. Core Voice DNA → profiles
  await db.prepare(`
    UPDATE profiles SET
      writing_samples           = COALESCE(?, writing_samples),
      website_url               = COALESCE(?, website_url),
      website_summary           = COALESCE(?, website_summary),
      website_extracted_at      = COALESCE(?, website_extracted_at),
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
    writing_samples || null,
    website_url || null, website_summary || null, website_extracted_at || null,
    onboarding_q2 || null, onboarding_q3 || null,
    onboarding_q_completed_at || null, onboarding_completed_at || null,
    authority_statements || null, cta_library || null, content_principles || null,
    content_themes || null, content_pillars || null,
    obComplete,
    profileId,
  );

  // 4. Brand Voice → brand_voice_profiles (UPSERT)
  if (hasBrandVoiceField) {
    await upsertBrandVoice(profileId, {
      brand_description:        brand_description        || null,
      brand_industry:           brand_industry           || null,
      brand_personality_traits: brand_personality_traits || null,
      brand_emotional_tone:     brand_emotional_tone     || null,
      elevator_main_result:     elevator_main_result     || null,
      elevator_mechanism:       elevator_mechanism       || null,
      brand_archetype:          brand_archetype          || null,
      brand_core_beliefs:       brand_core_beliefs       || null,
      brand_phrases_to_use:     brand_phrases_to_use     || null,
      brand_story_origin:       brand_story_origin       || null,
      brand_voice_profile_json: brand_voice_profile_json || null,
    });
  }

  // 5. Audience → audience_profiles (UPSERT)
  if (hasAudienceField) {
    await upsertAudienceProfile(profileId, {
      audience_description:           audience_description           || null,
      audience_goals:                 audience_goals                 || null,
      audience_obstacles:             audience_obstacles             || null,
      audience_core_beliefs_market:   audience_core_beliefs_market   || null,
      audience_buying_stage:          audience_buying_stage          || null,
      audience_market_sophistication: audience_market_sophistication || null,
      audience_profile_json:          audience_profile_json          || null,
    });
  }

  // 6a. Fingerprint extraction when writing_samples changes (fire-and-forget)
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
          const updatedProfile = await getFullProfileById(profileId);
          const pct = calculateCompletionPct(updatedProfile || {});
          await db.prepare(
            'UPDATE profiles SET voice_profile_completion_pct = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
          ).run(pct, profileId);
        }
      })
      .catch(err => console.error('[profile] Fingerprint extraction failed (non-fatal):', err.message));
  } else if (hasVoiceDNAField) {
    // 6b. Voice DNA extraction when Q&A answers arrive (fire-and-forget)
    const { extractVoiceDNAFromQA, calculateCompletionPct } = require('../services/voiceExtraction');
    const hasNewQA = onboarding_q2 || onboarding_q3;
    if (hasNewQA) {
      extractVoiceDNAFromQA(profileId).catch(err =>
        console.error('[profile] extractVoiceDNAFromQA failed (non-fatal):', err.message)
      );
    }
    Promise.resolve().then(async () => {
      const updatedProfile = await getFullProfileById(profileId);
      const pct = calculateCompletionPct(updatedProfile || {});
      await db.prepare(
        'UPDATE profiles SET voice_profile_completion_pct = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(pct, profileId);
    }).catch(() => {});
  } else if (hasBrandVoiceField || hasAudienceField) {
    // 6c. Recalculate score when brand voice or audience fields are saved
    const { calculateCompletionPct } = require('../services/voiceExtraction');
    Promise.resolve().then(async () => {
      const updatedProfile = await getFullProfileById(profileId);
      const pct = calculateCompletionPct(updatedProfile || {});
      await db.prepare(
        'UPDATE profiles SET voice_profile_completion_pct = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(pct, profileId);
    }).catch(() => {});
  }

  // 7. Onboarding completion: stamp timestamp + fire extraction jobs
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
- brand_description: One sentence — what this person/business does and who they serve. E.g. "I help DTC founders scale from $1M to $10M revenue without hiring a big agency."
- elevator_main_result: The #1 transformation or outcome they deliver (only if clearly inferable). E.g. "Add $1M ARR in 12 months"
- audience_description: 1-2 sentences describing their ideal client — who they are, their role, situation. E.g. "B2B SaaS founders at Series A who need to build repeatable sales processes."
- brand_core_beliefs: A JSON array of 1-2 strong opinions or contrarian stances visible on the site (only if clearly inferable). E.g. ["Most agencies overpromise and underdeliver", "Consistency beats virality every time"]

Return null for any field you cannot confidently infer. Return only the JSON object, no other text.`,
      }],
    });

    const raw = message.content[0]?.text || '{}';
    let extracted = {};
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      extracted = JSON.parse(match ? match[0] : raw);
    } catch { /* malformed JSON — client falls back silently */ }

    if (Array.isArray(extracted.brand_core_beliefs)) {
      extracted.brand_core_beliefs = JSON.stringify(extracted.brand_core_beliefs);
    }

    const summaryParts = [];
    if (extracted.brand_description)    summaryParts.push(extracted.brand_description);
    if (extracted.audience_description) summaryParts.push(`Audience: ${extracted.audience_description}`);
    const website_summary = summaryParts.join(' ') || null;

    if (website_summary) {
      db.prepare(
        `UPDATE profiles SET website_summary = ?, website_extracted_at = CURRENT_TIMESTAMP
         WHERE workspace_id = ? AND is_default = true`
      ).run(website_summary, req.tenantId).catch(() => {});
    }

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
// ---------------------------------------------------------------------------
router.post('/suggest-themes', async (req, res) => {
  const Anthropic = require('@anthropic-ai/sdk');
  const { getSetting } = require('../db');

  try {
    const profile = await db.prepare(`
      SELECT p.website_summary, p.onboarding_q2, p.onboarding_q3,
             bvp.brand_description, bvp.brand_core_beliefs,
             audp.audience_description
      FROM profiles p
      LEFT JOIN brand_voice_profiles bvp ON bvp.profile_id = p.id
      LEFT JOIN audience_profiles    audp ON audp.profile_id = p.id
      WHERE p.workspace_id = ? AND p.is_default = true
    `).get(req.tenantId);

    if (!profile) return res.json({ ok: true, themes: [] });

    let beliefsText = '';
    try {
      const beliefs = JSON.parse(profile.brand_core_beliefs || '[]');
      if (beliefs.length) beliefsText = beliefs[0];
    } catch { /* ignore */ }

    const context = [
      profile.brand_description    && `What they do: ${profile.brand_description}`,
      profile.website_summary      && `Website summary: ${profile.website_summary}`,
      profile.audience_description && `Audience: ${profile.audience_description}`,
      beliefsText                  && `POV: ${beliefsText}`,
      profile.onboarding_q2        && `Voice (Q2): ${profile.onboarding_q2}`,
      profile.onboarding_q3        && `Proof (Q3): ${profile.onboarding_q3}`,
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
// ---------------------------------------------------------------------------
router.post('/generate-positioning', async (req, res) => {
  const { brand_description, audience_description } = req.body;
  if (!brand_description && !audience_description) {
    return res.status(400).json({ ok: false, error: 'missing_fields', message: 'Provide at least brand_description or audience_description' });
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
        content: `Generate a one-sentence elevator pitch describing the #1 result this person delivers.

What they do: ${brand_description || 'not specified'}
Their audience: ${audience_description || 'not specified'}

Format: "I help [specific audience] [achieve specific result] [without/by doing X]."
Be concrete and specific. No preamble, no quotes around the sentence.`,
      }],
    });

    const result = (message.content[0]?.text || '').trim();
    return res.json({ ok: true, elevator_main_result: result });
  } catch (err) {
    console.error('[profile] generate-positioning error:', err.message);
    return res.status(500).json({ ok: false, error: 'generation_failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/profile/generate-input-examples
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
// Saves writing samples + Q&A for a LinkedIn-linked profile.
// ---------------------------------------------------------------------------
router.post('/:id/voice-setup', async (req, res) => {
  const profileId = Number(req.params.id);
  const tenantId  = req.tenantId;

  if (!Number.isFinite(profileId) || profileId <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_profile_id' });
  }

  const { writingSamples, q2 } = req.body;
  if (!writingSamples && !q2) {
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
        onboarding_q2   = COALESCE(?, onboarding_q2),
        updated_at      = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(writingSamples || null, q2 || null, profileId);

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

// ---------------------------------------------------------------------------
// PUT /api/profile/person/:id
// Update editable voice-DNA fields on a personal (LinkedIn) profile.
// Brand voice + audience fields route to their dedicated tables.
// ---------------------------------------------------------------------------
router.put('/person/:id', async (req, res) => {
  const tenantId  = req.tenantId;
  const profileId = Number(req.params.id);

  if (!req.userId)                        return res.status(401).json({ ok: false, error: 'unauthenticated' });
  if (!Number.isFinite(profileId))        return res.status(400).json({ ok: false, error: 'invalid_id' });

  try {
    const existing = await db.prepare(
      `SELECT id FROM profiles WHERE id = ? AND workspace_id = ?`
    ).get(profileId, tenantId);
    if (!existing) return res.status(404).json({ ok: false, error: 'not_found' });

    const brandVoiceAllowed = [
      'brand_description', 'brand_industry', 'brand_personality_traits', 'brand_emotional_tone',
      'elevator_main_result', 'elevator_mechanism', 'brand_archetype', 'brand_core_beliefs',
      'brand_phrases_to_use', 'brand_story_origin',
    ];
    const audienceAllowed = [
      'audience_description', 'audience_goals', 'audience_obstacles',
      'audience_core_beliefs_market', 'audience_buying_stage', 'audience_market_sophistication',
    ];
    const profileAllowed = ['content_pillars', 'content_themes'];

    const bvUpdates  = {};
    const audUpdates = {};
    const pUpdates   = {};

    for (const field of brandVoiceAllowed) {
      if (req.body[field] !== undefined) bvUpdates[field]  = req.body[field] || null;
    }
    for (const field of audienceAllowed) {
      if (req.body[field] !== undefined) audUpdates[field] = req.body[field] || null;
    }
    for (const field of profileAllowed) {
      if (req.body[field] !== undefined) pUpdates[field]   = req.body[field] || null;
    }

    if (Object.keys(bvUpdates).length === 0 && Object.keys(audUpdates).length === 0
        && Object.keys(pUpdates).length === 0) {
      return res.json({ ok: true, updated: [] });
    }

    if (Object.keys(bvUpdates).length > 0)  await upsertBrandVoice(profileId, bvUpdates);
    if (Object.keys(audUpdates).length > 0) await upsertAudienceProfile(profileId, audUpdates);

    if (Object.keys(pUpdates).length > 0) {
      const setClauses = Object.keys(pUpdates).map(k => `${k} = ?`).join(', ');
      const values     = [...Object.values(pUpdates), profileId, tenantId];
      await db.prepare(
        `UPDATE profiles SET ${setClauses}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ?`
      ).run(...values);
    }

    return res.json({ ok: true, updated: [...Object.keys(bvUpdates), ...Object.keys(audUpdates), ...Object.keys(pUpdates)] });
  } catch (err) {
    console.error('[profile/person/put] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/profile/brand-voice/generate
// mode=prefill: returns AI-drafted Step 2 suggestions (does not save).
// mode=final: returns full brand voice JSON and saves to brand_voice_profiles.
// ---------------------------------------------------------------------------
router.post('/brand-voice/generate', async (req, res) => {
  const { tenantId } = req;
  const { mode = 'prefill' } = req.body;

  try {
    const profile = await db.prepare(`
      ${FULL_PROFILE_SQL} WHERE p.workspace_id = ? AND p.is_default = true
    `).get(tenantId);
    if (!profile) return res.status(404).json({ ok: false, error: 'no_profile' });

    const { generateBrandVoiceProfile } = require('../lib/prompts/brandVoicePrompt');
    const result = await generateBrandVoiceProfile(profile, mode);

    if (mode === 'final' && result?.brand_voice_profile_json) {
      const profileIdRow = await db.prepare(
        'SELECT id FROM profiles WHERE workspace_id = ? AND is_default = true'
      ).get(tenantId);
      if (profileIdRow) {
        await upsertBrandVoice(profileIdRow.id, {
          brand_voice_profile_json: result.brand_voice_profile_json,
        });
      }
    }

    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[profile/brand-voice/generate] error:', err.message);
    return res.status(500).json({ ok: false, error: 'generation_failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/profile/audience/generate
// mode=prefill: returns AI-drafted Step 2 suggestions (does not save).
// mode=final: returns full audience JSON and saves to audience_profiles.
// ---------------------------------------------------------------------------
router.post('/audience/generate', async (req, res) => {
  const { tenantId } = req;
  const { mode = 'prefill' } = req.body;

  try {
    const profile = await db.prepare(`
      ${FULL_PROFILE_SQL} WHERE p.workspace_id = ? AND p.is_default = true
    `).get(tenantId);
    if (!profile) return res.status(404).json({ ok: false, error: 'no_profile' });

    const { generateAudienceProfile } = require('../lib/prompts/audiencePrompt');
    const result = await generateAudienceProfile(profile, mode);

    if (mode === 'final' && result?.audience_profile_json) {
      const profileIdRow = await db.prepare(
        'SELECT id FROM profiles WHERE workspace_id = ? AND is_default = true'
      ).get(tenantId);
      if (profileIdRow) {
        await upsertAudienceProfile(profileIdRow.id, {
          audience_profile_json: result.audience_profile_json,
        });
      }
    }

    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[profile/audience/generate] error:', err.message);
    return res.status(500).json({ ok: false, error: 'generation_failed' });
  }
});

module.exports = router;

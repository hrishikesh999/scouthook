'use strict';

/**
 * voiceExtraction.js — Sprint 2 Voice DNA Architecture
 *
 * Four exported functions:
 *   extractVoiceDNAFromQA     — fire-and-forget after onboarding Q3 submit
 *   buildVoiceDNABlock        — replaces buildFingerprintBlock() in prompt builders (superset)
 *   calculateCompletionPct    — server-side voice profile completion score
 *   captureVoiceRefinement    — edit-delta capture when user edits >30% of a post
 *   extractVoiceDNAFromLinkedIn — STUB (Phase A spike deferred)
 *
 * All functions are additive — nothing in this file replaces or deletes existing behaviour.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { db, getSetting } = require('../db');
const {
  getAnthropicMessageText,
  extractJsonFromResponse,
} = require('./voiceFingerprint');

// buildFingerprintBlock is defined locally in ideaPath.js and reachBrainstormer.js (not exported).
// We inline the same logic here to avoid circular dependencies.
// When those files are updated to call buildVoiceDNABlock(), this block is what they inherit.
function buildFingerprintBlock(userProfile) {
  const fingerprint = userProfile.voice_fingerprint
    ? safeParseJSON(userProfile.voice_fingerprint, null)
    : null;
  if (!fingerprint) return '';
  return `VOICE FINGERPRINT (strictly follow these patterns):
- Opening style: ${fingerprint.opening_style || ''}
- Sentence structure: ${fingerprint.sentence_structure || ''}
- Credibility mechanism: ${fingerprint.credibility_mechanism || ''}
- Signature moves: ${(fingerprint.signature_moves || []).join(', ')}`;
}

/* ── Universal banned patterns list ─────────────────────────────────────────
   Always prepended to any user-specific banned patterns.
   Source: cleanup-prompt reference (Dropbox/ScoutHook/Reference/4.cleanup-prompt.rtf)
   ──────────────────────────────────────────────────────────────────────── */
const UNIVERSAL_BANNED_PATTERNS = [
  'delve', 'leverage', 'elevate', 'supercharge', 'unlock', 'harness', 'empower',
  'game-changer', 'next-level', 'crushing it', 'killing it',
  "it's worth noting", "it's important to mention", "it's crucial to understand",
  "in today's fast-paced world", "in today's digital age",
  "in conclusion", "to wrap up", "ultimately",
  "let's dive in", "buckle up", "strap in",
  'synergy', 'ideate', 'robust', 'seamless', 'holistic', 'tapestry',
  'underscore', 'myriad', 'plethora', 'navigate the complexities',
  "the world of", "in the realm of",
  "not just X but Y", "this isn't just X it's Y",
  "whether you're X or Y",
];

/* ── Helpers ────────────────────────────────────────────────────────────── */

function safeParseJSON(val, fallback) {
  if (!val) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

async function getAnthropicClient() {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');
  return new Anthropic({ apiKey });
}

/* ── 1. extractVoiceDNAFromQA ───────────────────────────────────────────
   Fire-and-forget. Called after onboarding Q3 submit. Never blocks generation.
   Reads fresh from DB, merges into voice_fingerprint, writes new Voice DNA fields.
   ──────────────────────────────────────────────────────────────────────── */

async function extractVoiceDNAFromQA(userId, tenantId) {
  try {
    // Read fresh profile from DB — include writing samples and blog articles for richer signal
    const profile = await db.prepare(
      `SELECT user_role, website_summary, website_articles_text,
              onboarding_q1, onboarding_q2, onboarding_q3,
              voice_fingerprint, authority_statements, banned_patterns,
              business_positioning, writing_samples
       FROM user_profiles WHERE user_id = ? AND tenant_id = ?`
    ).get(userId, tenantId);

    if (!profile) {
      console.warn('[voiceExtraction] extractVoiceDNAFromQA: profile not found', { userId, tenantId });
      return;
    }

    const { onboarding_q1, onboarding_q2, onboarding_q3 } = profile;

    // If all Q&A fields are empty, nothing to extract
    if (!onboarding_q1 && !onboarding_q2 && !onboarding_q3) {
      await db.prepare(
        `UPDATE user_profiles SET voice_extraction_source = 'none' WHERE user_id = ? AND tenant_id = ?`
      ).run(userId, tenantId);
      return;
    }

    const client = await getAnthropicClient();

    const prompt = buildQAExtractionPrompt(profile);

    // Upgrade to Sonnet for this one-time extraction — richer signal is worth the cost.
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const responseText = getAnthropicMessageText(message);
    let extracted;
    try {
      extracted = extractJsonFromResponse(responseText);
    } catch (parseErr) {
      console.error('[voiceExtraction] extractVoiceDNAFromQA: JSON parse failed', parseErr.message);
      await db.prepare(
        `UPDATE user_profiles SET voice_extraction_source = 'none' WHERE user_id = ? AND tenant_id = ?`
      ).run(userId, tenantId);
      return;
    }

    if (!extracted || typeof extracted !== 'object') return;

    // Business positioning — derive from positioning.outcome if currently blank
    const positioningOutcome = (extracted.positioning?.outcome || '').trim() || null;

    // Merge into existing voice_fingerprint (preserve existing fields, add new ones)
    const existingFp = safeParseJSON(profile.voice_fingerprint, {});
    const newFields = {
      tone:             extracted.tone             || undefined,
      energy:           extracted.energy           || undefined,
      persona_traits:   extracted.persona_traits   || undefined,
      never_sounds_like:extracted.never_sounds_like|| undefined,
      sentence_tendency:extracted.sentence_tendency|| undefined,
      sentence_rhythm:  extracted.sentence_rhythm  || undefined,
      vocabulary_tier:  extracted.vocabulary_tier  || undefined,
      opening_move:     extracted.opening_move     || undefined,
      never_says:       extracted.never_says       || undefined,
      argument_structure:extracted.argument_structure || undefined,
      specificity_level:extracted.specificity_level|| undefined,
      sample_phrases:   extracted.sample_phrases   || undefined,
      positioning:      extracted.positioning      || undefined,
    };
    // Remove undefined keys so we don't overwrite real values with undefined
    Object.keys(newFields).forEach(k => newFields[k] === undefined && delete newFields[k]);

    // Determine extraction source based on available signal
    const hasWritingSamples = (profile.writing_samples || '').trim().length > 100;
    const hasBlogArticles   = (profile.website_articles_text || '').trim().length > 200;
    const extractionSource  = hasWritingSamples && hasBlogArticles ? 'combined'
      : hasWritingSamples ? 'writing_samples'
      : hasBlogArticles   ? 'website_articles'
      : 'qa_answers';

    const mergedFp = Object.assign({}, existingFp, newFields);

    // Authority statements — verbatim from Q3 only, never overwrite existing if already set
    const existingStatements = safeParseJSON(profile.authority_statements, []);
    const newStatements = Array.isArray(extracted.authority_statements)
      ? extracted.authority_statements.filter(s => typeof s === 'string' && s.trim())
      : [];
    // Merge: prefer new (freshly extracted), but keep existing if extraction returned nothing
    const mergedStatements = newStatements.length > 0 ? newStatements : existingStatements;

    // Banned patterns — universal list always first, then user-specific additions
    const userSpecificBanned = Array.isArray(extracted.banned_patterns)
      ? extracted.banned_patterns.filter(p => typeof p === 'string' && p.trim())
      : [];
    const mergedBanned = [
      ...UNIVERSAL_BANNED_PATTERNS,
      ...userSpecificBanned.filter(p => !UNIVERSAL_BANNED_PATTERNS.includes(p)),
    ];

    // Check LinkedIn connection for completion pct
    const linkedInRow = await db.prepare(
      'SELECT 1 FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
    ).get(userId, tenantId);
    const hasLinkedIn = !!linkedInRow;

    // Build updated profile object for completion calc
    const updatedProfile = {
      ...profile,
      voice_fingerprint: JSON.stringify(mergedFp),
      authority_statements: JSON.stringify(mergedStatements),
      banned_patterns: JSON.stringify(mergedBanned),
      // business_positioning: use existing value if already set, otherwise use derived outcome
      business_positioning: profile.business_positioning || positioningOutcome,
    };
    const completionPct = calculateCompletionPct(updatedProfile, hasLinkedIn);

    const extractionQuality = (hasWritingSamples || hasBlogArticles) ? 'partial' : 'baseline';

    await db.prepare(
      `UPDATE user_profiles SET
         voice_fingerprint            = ?,
         authority_statements         = ?,
         banned_patterns              = ?,
         business_positioning         = COALESCE(business_positioning, ?),
         voice_extraction_source      = ?,
         voice_extraction_quality     = ?,
         voice_profile_completion_pct = ?,
         updated_at                   = CURRENT_TIMESTAMP
       WHERE user_id = ? AND tenant_id = ?`
    ).run(
      JSON.stringify(mergedFp),
      JSON.stringify(mergedStatements),
      JSON.stringify(mergedBanned),
      positioningOutcome,
      extractionSource,
      extractionQuality,
      completionPct,
      userId,
      tenantId
    );

    console.log('[voiceExtraction] extractVoiceDNAFromQA: complete', { userId, completionPct, extractionSource });
  } catch (err) {
    console.error('[voiceExtraction] extractVoiceDNAFromQA: error (non-fatal):', err.message);
    try {
      await db.prepare(
        `UPDATE user_profiles SET voice_extraction_source = 'none' WHERE user_id = ? AND tenant_id = ?`
      ).run(userId, tenantId);
    } catch { /* ignore secondary failure */ }
  }
}

function buildQAExtractionPrompt(profile) {
  const {
    user_role, website_summary, website_articles_text,
    onboarding_q1, onboarding_q2, onboarding_q3, writing_samples,
  } = profile;

  // Build writing signal section — use real writing if available, fall back to Q&A
  const writingSignal = [];
  if (writing_samples && writing_samples.trim().length > 100) {
    writingSignal.push(`WRITING SAMPLE (pasted by user — highest fidelity voice signal):\n${writing_samples.trim().slice(0, 2500)}`);
  }
  if (website_articles_text && website_articles_text.trim().length > 200) {
    writingSignal.push(`WEBSITE ARTICLES (crawled from their site — real authored content):\n${website_articles_text.trim().slice(0, 3000)}`);
  }

  const hasRealWriting = writingSignal.length > 0;

  return `You are extracting a voice profile from a professional's writing. Your job is to extract what is actually observable — never invent, never generalise.

SIGNAL QUALITY NOTE: ${hasRealWriting
    ? 'You have real authored writing to analyse (marked below). Prioritise these over Q&A answers for sentence rhythm, vocabulary, and opening style — authored writing is a far stronger signal than interview answers.'
    : 'You only have interview answers to work from. Q2 is the best signal for voice — it was answered casually and captures unguarded language.'
}

INPUTS:
- Role: ${user_role || 'not specified'}
- Website summary: ${website_summary || 'not provided'}
- Q1 (their contrarian POV — what their field gets wrong): ${onboarding_q1 || 'skipped'}
- Q2 (their voice — how they'd describe their work to a friend, unguarded): ${onboarding_q2 || 'skipped'}
- Q3 (a specific result they produced — credibility): ${onboarding_q3 || 'skipped'}
${writingSignal.length ? '\n' + writingSignal.join('\n\n') : ''}

EXTRACTION RULES:
- Be ruthlessly specific. "Direct tone" is useless. "Cuts to the result before explaining the method" is useful.
- For sentence_rhythm: quote an actual sentence from their writing to illustrate.
- For opening_move: describe what they literally do in the first 1-2 sentences of a piece.
- For never_says: look at what vocabulary is absent from their writing — not just a generic list.
- For argument_structure: does the conclusion come first or last? Do they set up context or dive in?
- Return null for any field you genuinely cannot observe. Do NOT invent.

Return valid JSON only. No commentary, no markdown, no explanation outside the JSON object.

{
  "tone": "3-5 word description drawn directly from word choice and phrasing — e.g. 'direct, outcome-first, mildly contrarian' not 'professional'",
  "energy": "one of: calm | punchy | earnest | sarcastic",
  "persona_traits": ["observable trait — max 3"],
  "never_sounds_like": "one phrase for what this person would never sound like — e.g. 'a motivational speaker padding out a point'",
  "sentence_tendency": "one of: short/punchy | long-form | mixed",
  "sentence_rhythm": "one sentence describing their rhythm with a direct example — e.g. 'Punchy and staccato. Rarely more than 12 words. Example: \\"Most founders don't have a sales problem. They have a positioning problem.\\"'",
  "vocabulary_tier": "one of: technical/jargon | everyday/plain | formal/academic | casual/conversational — pick the single best fit",
  "opening_move": "what they literally do in their first 1-2 sentences — e.g. 'Leads with the surprising result, then explains how they got there' or 'Opens with a question that reframes the reader's assumption'",
  "never_says": "2-3 specific words or phrases that would feel wrong in their voice — inferred from their actual vocabulary, not generic AI smell list",
  "argument_structure": "one of: conclusion-first | build-to-conclusion | problem-then-solution | story-then-lesson",
  "specificity_level": "one of: high | medium | low — based on whether they gave numbers, names, concrete details or stayed vague",
  "sample_phrases": ["verbatim phrase from their writing that captures their voice — not paraphrased — max 5"],
  "positioning": {
    "stands_for": "what they believe — from Q1 or their writing",
    "pushes_back_against": "what they reject — from Q1",
    "audience": "who they help — from website_summary or Q3",
    "outcome": "the result they produce — from Q3, verbatim if possible"
  },
  "authority_statements": ["verbatim credibility claim from Q3 or their writing — exact wording, not a summary — max 3"],
  "banned_patterns": ["word or phrase that would feel wrong in their voice — inferred from vocabulary absences — max 5"]
}`;
}

/* ── 2. buildVoiceDNABlock ──────────────────────────────────────────────
   Superset of buildFingerprintBlock(). Backward-compatible.
   buildFingerprintBlock() is called first — any caller that hasn't been
   updated yet still gets the original fingerprint block.
   ──────────────────────────────────────────────────────────────────────── */

function buildVoiceDNABlock(userProfile) {
  const parts = [];
  const fp = safeParseJSON(userProfile.voice_fingerprint, {});

  // 1. Core fingerprint — backward compat (calls existing function)
  const fingerprintBlock = buildFingerprintBlock(userProfile);
  if (fingerprintBlock) parts.push(fingerprintBlock);

  // 2. Extended voice dimensions (populated by extractVoiceDNAFromQA)
  if (fp.tone) {
    const voiceLines = [`Tone: ${fp.tone}`];
    if (fp.energy)             voiceLines.push(`Energy: ${fp.energy}`);
    if (fp.persona_traits?.length) voiceLines.push(`Persona: ${fp.persona_traits.join(', ')}`);
    if (fp.never_sounds_like)  voiceLines.push(`Never sounds like: ${fp.never_sounds_like}`);
    if (fp.sentence_tendency)  voiceLines.push(`Sentence style: ${fp.sentence_tendency}`);
    if (fp.sentence_rhythm)    voiceLines.push(`Sentence rhythm: ${fp.sentence_rhythm}`);
    if (fp.vocabulary_tier)    voiceLines.push(`Vocabulary: ${fp.vocabulary_tier}`);
    if (fp.opening_move)       voiceLines.push(`Opening move: ${fp.opening_move}`);
    if (fp.argument_structure) voiceLines.push(`Argument structure: ${fp.argument_structure}`);
    parts.push(`VOICE:\n${voiceLines.join('\n')}`);
  }

  // 2b. Never-says — separate block so it reads as an absolute rule, not a trait
  if (fp.never_says) {
    parts.push(`NEVER SAYS (these specific words/phrases would break their voice — avoid absolutely):\n${fp.never_says}`);
  }

  // 3. Positioning (from Q1)
  const pos = fp.positioning;
  if (pos?.pushes_back_against) {
    const posLines = [];
    if (pos.stands_for)           posLines.push(`Stands for: ${pos.stands_for}`);
    if (pos.pushes_back_against)  posLines.push(`Pushes back against: ${pos.pushes_back_against}`);
    if (pos.audience)             posLines.push(`Audience: ${pos.audience}`);
    if (pos.outcome)              posLines.push(`Outcome they deliver: ${pos.outcome}`);
    if (posLines.length) parts.push(`POSITIONING:\n${posLines.join('\n')}`);
  }

  // 4. Authority statements (verbatim from Q3 — weave naturally, never list)
  const statements = safeParseJSON(userProfile.authority_statements, []);
  if (statements.length > 0) {
    parts.push(
      `AUTHOR CREDIBILITY (weave naturally into the post — never list these verbatim):\n` +
      statements.map(s => `- ${s}`).join('\n')
    );
  }

  // 5. Voice anchors — sample phrases from Q2 (mirror these patterns)
  if ((fp.sample_phrases || []).length > 0) {
    parts.push(
      `VOICE ANCHORS (mirror these sentence patterns — do not copy verbatim):\n` +
      fp.sample_phrases.map(p => `- "${p}"`).join('\n')
    );
  }

  // 6. Banned patterns — ABSOLUTE RULES
  const banned = safeParseJSON(userProfile.banned_patterns, []);
  if (banned.length > 0) {
    parts.push(`BANNED — NEVER USE ANY OF THESE:\n${banned.join(', ')}`);
  }

  // 7. Content principles (user-defined, optional — advanced wizard stage)
  const principles = safeParseJSON(userProfile.content_principles, []);
  if (principles.length > 0) {
    parts.push(
      `CONTENT RULES (always follow):\n` +
      principles.map(p => `- ${p}`).join('\n')
    );
  }

  // 8. CTA library — use one, rotate, never invent a new one
  const ctas = safeParseJSON(userProfile.cta_library, []);
  if (ctas.length > 0) {
    parts.push(
      `CALLS TO ACTION (use one from this list — rotate across posts — never invent a new one):\n` +
      ctas.map(c => `- ${c}`).join('\n')
    );
  }

  // 9. Recent voice refinements (last 5 from edit-delta capture)
  const refinements = safeParseJSON(userProfile.voice_refinements, []);
  const recent = refinements.slice(-5);
  if (recent.length > 0) {
    parts.push(
      `RECENT CORRECTIONS (the author has demonstrated these preferences through edits):\n` +
      recent.map(r => `- ${r}`).join('\n')
    );
  }

  // 10. Content themes (confirmed in Voice Profile Wizard Stage 1)
  const themes = safeParseJSON(userProfile.content_themes, []);
  if (themes.length > 0) {
    parts.push(
      `CONTENT THEMES (stay within these topic areas):\n` +
      themes.map(t => `- ${t}`).join('\n')
    );
  }

  return parts.join('\n\n');
}

/* ── 3. calculateCompletionPct ──────────────────────────────────────────
   Server-side scoring. hasLinkedIn is a boolean passed by the caller
   (NOT userProfile.linkedin_access_token — that lives in linkedin_tokens).
   Caller must: const hasLinkedIn = !!db.prepare(
     'SELECT 1 FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
   ).get(userId, tenantId);
   ──────────────────────────────────────────────────────────────────────── */

function calculateCompletionPct(userProfile, hasLinkedIn = false) {
  let score = 0;

  if (userProfile.user_role)            score += 5;
  if (userProfile.website_url)          score += 5;
  if (userProfile.onboarding_q1)        score += 5;
  if (userProfile.onboarding_q2)        score += 5;
  if (userProfile.onboarding_q3)        score += 5;
  if (userProfile.voice_fingerprint)    score += 5;
  if (userProfile.business_positioning) score += 3;
  if (userProfile.content_niche)        score += 2;

  // writing_samples is a plain string (textarea), not a JSON array.
  // Credit based on character length: 200+ chars = baseline, 600+ chars = richer sample.
  const samplesStr = (userProfile.writing_samples || '').trim();
  if (samplesStr.length >= 200)         score += 15;
  if (samplesStr.length >= 600)         score += 5;

  const statements = safeParseJSON(userProfile.authority_statements, []);
  if (statements.length >= 3)           score += 10;

  const ctas = safeParseJSON(userProfile.cta_library, []);
  if (ctas.length >= 2)                 score += 10;

  const principles = safeParseJSON(userProfile.content_principles, []);
  if (principles.length >= 3)           score += 5;

  if (hasLinkedIn)                      score += 20;

  return Math.min(score, 100);
}

/* ── 4. captureVoiceRefinement ──────────────────────────────────────────
   Called fire-and-forget from PATCH /api/posts/:postId when edit ratio > 30%.
   Extracts one short rule from the diff, appends to voice_refinements (cap 20).
   ──────────────────────────────────────────────────────────────────────── */

async function captureVoiceRefinement(userId, tenantId, oldContent, newContent, changeTypes = ['general']) {
  try {
    const client = await getAnthropicClient();

    const typeDescriptions = {
      hook:       'the opening line/hook changed',
      vocabulary: 'specific words and phrases were substituted',
      length:     'the post length changed significantly',
      general:    'various edits were made throughout',
    };
    const changeDesc = changeTypes.map(t => typeDescriptions[t] || t).join('; ');
    const ruleCount  = changeTypes.length === 1 ? 'one short rule' : `${changeTypes.length} short rules (one per detected change)`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `A writer edited an AI-generated LinkedIn post. Detected changes: ${changeDesc}.

Extract ${ruleCount} describing their writing preferences. Each rule must be under 20 words.

BEFORE:
${oldContent.slice(0, 600)}

AFTER:
${newContent.slice(0, 600)}

Return each rule on its own line, no bullets, no commentary.
Example: "Prefers shorter sentences — never more than 15 words in a row."`,
      }],
    });

    const responseText = getAnthropicMessageText(message).trim();
    const rules = responseText
      .split('\n')
      .map(line => line.replace(/^[-•*\d.]\s*/, '').trim())
      .filter(line => line.length > 5 && line.length < 150);

    if (rules.length === 0) return;

    // Read current refinements
    const row = await db.prepare(
      'SELECT voice_refinements FROM user_profiles WHERE user_id = ? AND tenant_id = ?'
    ).get(userId, tenantId);

    if (!row) return;

    const refinements = safeParseJSON(row.voice_refinements, []);
    refinements.push(...rules);

    // Cap at 20 — remove oldest when over
    if (refinements.length > 20) refinements.splice(0, refinements.length - 20);

    // Recalculate completion pct
    const profile = await db.prepare(
      'SELECT * FROM user_profiles WHERE user_id = ? AND tenant_id = ?'
    ).get(userId, tenantId);
    const linkedInRow = await db.prepare(
      'SELECT 1 FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
    ).get(userId, tenantId);
    const completionPct = calculateCompletionPct(
      { ...profile, voice_refinements: JSON.stringify(refinements) },
      !!linkedInRow
    );

    await db.prepare(
      `UPDATE user_profiles SET
         voice_refinements            = ?,
         voice_profile_completion_pct = ?,
         updated_at                   = CURRENT_TIMESTAMP
       WHERE user_id = ? AND tenant_id = ?`
    ).run(JSON.stringify(refinements), completionPct, userId, tenantId);

    console.log('[voiceExtraction] captureVoiceRefinement: captured rules', { userId, rules });
  } catch (err) {
    console.error('[voiceExtraction] captureVoiceRefinement: error (non-fatal):', err.message);
  }
}

/* ── 5. extractVoiceDNAFromLinkedIn ────────────────────────────────────
   Uses the linkedin_headline (collected during OAuth) to auto-populate
   empty profile fields: content_niche, audience_role, business_positioning,
   and suggested content themes.
   Only fills fields that are currently blank — never overwrites user data.
   Fire-and-forget safe. Called after OAuth callback and on manual refresh.
   ──────────────────────────────────────────────────────────────────────── */

async function extractVoiceDNAFromLinkedIn(userId, tenantId) {
  try {
    // Read LinkedIn profile data (stored during OAuth callback)
    const liRow = await db.prepare(
      'SELECT linkedin_name, linkedin_headline FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
    ).get(userId, tenantId);

    if (!liRow?.linkedin_headline) {
      console.log('[voiceExtraction] extractVoiceDNAFromLinkedIn: no headline, skipping', { userId });
      return { updated: [] };
    }

    // Read current profile
    const profile = await db.prepare(
      `SELECT content_niche, audience_role, business_positioning, content_themes,
              voice_fingerprint, authority_statements, banned_patterns, writing_samples,
              cta_library, content_principles, user_role, website_url,
              onboarding_q1, onboarding_q2, onboarding_q3, voice_refinements
       FROM user_profiles WHERE user_id = ? AND tenant_id = ?`
    ).get(userId, tenantId);

    if (!profile) return { updated: [] };

    const client = await getAnthropicClient();

    const prompt = `You are extracting a LinkedIn creator's professional profile from their LinkedIn headline.

LinkedIn headline: "${liRow.linkedin_headline}"
${liRow.linkedin_name ? `Name: ${liRow.linkedin_name}` : ''}

Extract the following from the headline only. Be specific and grounded — do not invent.

Return valid JSON only, no commentary:
{
  "content_niche": "2-4 word niche label (e.g. 'B2B SaaS growth', 'executive leadership coaching', 'DTC e-commerce')",
  "audience_role": "who they help, 5-10 words (e.g. 'early-stage B2B SaaS founders', 'mid-market sales leaders')",
  "business_positioning": "one sentence: what they do and for whom (derived from headline — verbatim words preferred)",
  "suggested_themes": ["3-5 content themes this person would naturally write about on LinkedIn — short phrases"]
}`;

    const message = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 512,
      messages:   [{ role: 'user', content: prompt }],
    });

    const responseText = getAnthropicMessageText(message);
    let extracted;
    try {
      extracted = extractJsonFromResponse(responseText);
    } catch (parseErr) {
      console.error('[voiceExtraction] extractVoiceDNAFromLinkedIn: JSON parse failed', parseErr.message);
      return { updated: [] };
    }

    if (!extracted || typeof extracted !== 'object') return { updated: [] };

    // ── Source-aware merge strategy ─────────────────────────────────────────
    // LinkedIn headline is the BEST signal for persona/positioning fields
    // (user-crafted professional identity > website marketing copy).
    // So: always write content_niche, audience_role, business_positioning from
    // LinkedIn when we have a value — this correctly overrides website-extracted
    // values which are often generic copywriter language.
    //
    // Q&A-sourced fields (voice_fingerprint, authority_statements,
    // banned_patterns) are NEVER touched here — those come from the user's own
    // spoken-word interview answers and are a stronger signal.
    //
    // content_themes is always additive: merge, never remove.
    // ────────────────────────────────────────────────────────────────────────
    const updates = {};

    // Persona fields — LinkedIn wins over website extraction
    if (extracted.content_niche)        updates.content_niche        = extracted.content_niche;
    if (extracted.audience_role)        updates.audience_role        = extracted.audience_role;
    if (extracted.business_positioning) updates.business_positioning = extracted.business_positioning;

    // Themes — always additive (merge new ones in, never remove existing)
    const existingThemes = safeParseJSON(profile.content_themes, []);
    const suggestedThemes = Array.isArray(extracted.suggested_themes)
      ? extracted.suggested_themes.filter(t => typeof t === 'string' && t.trim())
      : [];
    const mergedThemes = [...existingThemes];
    suggestedThemes.forEach(t => { if (!mergedThemes.includes(t)) mergedThemes.push(t); });
    if (mergedThemes.length > existingThemes.length) {
      updates.content_themes = JSON.stringify(mergedThemes);
    }

    if (Object.keys(updates).length === 0) {
      console.log('[voiceExtraction] extractVoiceDNAFromLinkedIn: nothing to update', { userId });
      return { updated: [] };
    }

    // Recalculate completion pct with the new values
    const linkedInRow = await db.prepare(
      'SELECT 1 FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
    ).get(userId, tenantId);
    const updatedProfile = { ...profile, ...updates };
    const completionPct = calculateCompletionPct(updatedProfile, !!linkedInRow);
    updates.voice_profile_completion_pct = completionPct;

    // Build parameterised UPDATE from the updates object
    const keys = Object.keys(updates);
    const setClauses = keys.map(k => `${k} = ?`).join(', ');
    await db.prepare(
      `UPDATE user_profiles SET ${setClauses}, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND tenant_id = ?`
    ).run(...keys.map(k => updates[k]), userId, tenantId);

    console.log('[voiceExtraction] extractVoiceDNAFromLinkedIn: complete', { userId, updated: keys });
    return { updated: keys, completionPct };

  } catch (err) {
    console.error('[voiceExtraction] extractVoiceDNAFromLinkedIn: error (non-fatal):', err.message);
    return { updated: [] };
  }
}

module.exports = {
  extractVoiceDNAFromQA,
  buildVoiceDNABlock,
  calculateCompletionPct,
  captureVoiceRefinement,
  extractVoiceDNAFromLinkedIn,
};

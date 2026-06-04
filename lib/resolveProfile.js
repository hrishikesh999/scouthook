'use strict';

const { db } = require('../db');

/**
 * Resolve a profile row for a generation request.
 *
 * If `profileId` is provided, fetches that profile and verifies it belongs to
 * `workspaceId` (prevents cross-workspace voice leakage).
 * If `profileId` is omitted, returns the workspace's default brand profile.
 *
 * Returns null if no matching profile is found.
 */
async function resolveProfile(workspaceId, profileId) {
  if (!workspaceId) return null;

  if (profileId) {
    const id = Number(profileId);
    if (!Number.isInteger(id) || id <= 0) return null;
    return db.prepare(
      'SELECT * FROM profiles WHERE id = ? AND workspace_id = ?'
    ).get(id, workspaceId);
  }

  return db.prepare(
    'SELECT * FROM profiles WHERE workspace_id = ? AND is_default = true'
  ).get(workspaceId);
}

/**
 * Returns true if a profile field value is meaningfully populated.
 * Guards against null, empty string, and JSON empty values.
 */
function isPopulated(val) {
  if (val === null || val === undefined) return false;
  if (typeof val !== 'string') return true;
  const t = val.trim();
  return t.length > 0 && t !== 'null' && t !== '{}' && t !== '[]';
}

/**
 * Merge a brand profile (strategy context) with a personal profile (voice).
 *
 * Field priority rules:
 *   Voice fields      — personal dominates (how they sound)
 *   Strategy fields   — personal if populated, else brand (what/who)
 *   business_positioning — always brand (intentionally set workspace strategy)
 *
 * The returned object can be passed directly into any prompt builder without
 * changes — it looks identical to a single resolved profile row.
 */
function mergeProfiles(brandProfile, personalProfile) {
  if (!personalProfile) return brandProfile;
  if (!brandProfile)    return personalProfile;

  const pick = (personal, brand) => isPopulated(personal) ? personal : brand;

  return {
    // Spread brand as base so any unmapped columns are present
    ...brandProfile,

    // Identity — record-keeping against the personal profile's id
    id:           personalProfile.id,
    profile_type: personalProfile.profile_type,

    // ── Voice fields: personal dominates ──────────────────────────
    voice_fingerprint:         pick(personalProfile.voice_fingerprint,         brandProfile.voice_fingerprint),
    writing_samples:           pick(personalProfile.writing_samples,           brandProfile.writing_samples),
    writing_sample_phrases:    pick(personalProfile.writing_sample_phrases,    brandProfile.writing_sample_phrases),
    authority_statements:      pick(personalProfile.authority_statements,      brandProfile.authority_statements),
    banned_patterns:           pick(personalProfile.banned_patterns,           brandProfile.banned_patterns),
    content_principles:        pick(personalProfile.content_principles,        brandProfile.content_principles),
    cta_library:               pick(personalProfile.cta_library,               brandProfile.cta_library),
    voice_refinements:         pick(personalProfile.voice_refinements,         brandProfile.voice_refinements),
    input_examples:            pick(personalProfile.input_examples,            brandProfile.input_examples),
    onboarding_q1:             pick(personalProfile.onboarding_q1,             brandProfile.onboarding_q1),
    onboarding_q2:             pick(personalProfile.onboarding_q2,             brandProfile.onboarding_q2),
    onboarding_q3:             pick(personalProfile.onboarding_q3,             brandProfile.onboarding_q3),
    user_archetype_preference: pick(personalProfile.user_archetype_preference, brandProfile.user_archetype_preference),

    // ── Strategy fields: personal if populated, else brand ────────
    content_niche:    pick(personalProfile.content_niche,    brandProfile.content_niche),
    audience_role:    pick(personalProfile.audience_role,    brandProfile.audience_role),
    audience_pain:    pick(personalProfile.audience_pain,    brandProfile.audience_pain),
    content_pillars:  pick(personalProfile.content_pillars,  brandProfile.content_pillars),
    contrarian_view:  pick(personalProfile.contrarian_view,  brandProfile.contrarian_view),
    content_themes:   pick(personalProfile.content_themes,   brandProfile.content_themes),

    // ── Brand context: always workspace-level ─────────────────────
    // business_positioning is the intentionally crafted strategic layer —
    // it should frame every post regardless of whose voice is used.
    business_positioning: brandProfile.business_positioning,

    // ── Metadata ──────────────────────────────────────────────────
    onboarding_complete:          !!(personalProfile.onboarding_complete || brandProfile.onboarding_complete),
    voice_profile_completion_pct: Math.max(
      personalProfile.voice_profile_completion_pct || 0,
      brandProfile.voice_profile_completion_pct    || 0
    ),
    voice_extraction_quality: pick(personalProfile.voice_extraction_quality, brandProfile.voice_extraction_quality),
    website_url:              pick(personalProfile.website_url,     brandProfile.website_url),
    website_summary:          pick(personalProfile.website_summary, brandProfile.website_summary),
  };
}

module.exports = { resolveProfile, mergeProfiles };

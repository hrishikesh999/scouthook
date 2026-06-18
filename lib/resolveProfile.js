'use strict';

const { db } = require('../db');

/**
 * Resolve the workspace's Voice DNA profile for a generation request.
 *
 * Always returns the workspace's single default profile.
 * `profileId` is accepted but ignored — there is one profile per workspace.
 *
 * Returns null if no default profile exists for the workspace.
 */
async function resolveProfile(workspaceId, _profileId) {
  if (!workspaceId) return null;
  return db.prepare(`
    SELECT p.*,
      bvp.brand_description, bvp.brand_industry, bvp.brand_personality_traits,
      bvp.brand_emotional_tone, bvp.elevator_main_result, bvp.elevator_mechanism,
      bvp.brand_archetype, bvp.brand_core_beliefs, bvp.brand_phrases_to_use,
      bvp.brand_story_origin, bvp.brand_voice_profile_json,
      ap.audience_description, ap.audience_goals, ap.audience_obstacles,
      ap.audience_core_beliefs_market, ap.audience_buying_stage, ap.audience_market_sophistication
    FROM profiles p
    LEFT JOIN brand_voice_profiles bvp ON bvp.profile_id = p.id
    LEFT JOIN audience_profiles ap ON ap.profile_id = p.id
    WHERE p.workspace_id = ? AND p.is_default = true
  `).get(workspaceId);
}

module.exports = { resolveProfile };

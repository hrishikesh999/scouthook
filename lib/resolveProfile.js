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
  return db.prepare(
    'SELECT * FROM profiles WHERE workspace_id = ? AND is_default = true'
  ).get(workspaceId);
}

module.exports = { resolveProfile };

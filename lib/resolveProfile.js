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

module.exports = { resolveProfile };

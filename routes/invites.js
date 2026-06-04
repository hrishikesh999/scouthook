'use strict';

const express = require('express');
const router  = express.Router();
const { db }  = require('../db');

// ---------------------------------------------------------------------------
// GET /api/invites/:token
// Validate an invite token — public, no auth required.
// Returns workspace name + role so the accept page can show context before login.
// ---------------------------------------------------------------------------
router.get('/:token', async (req, res) => {
  const { token } = req.params;
  if (!token) return res.status(400).json({ ok: false, error: 'missing_token' });

  try {
    const invite = await db.prepare(`
      SELECT wi.id, wi.email, wi.role, wi.expires_at,
             w.name  AS workspace_name,
             up.display_name AS inviter_name
      FROM   workspace_invites wi
      JOIN   workspaces w  ON w.id  = wi.workspace_id
      LEFT JOIN user_profiles up ON up.user_id = wi.invited_by
      WHERE  wi.token = ?
        AND  wi.accepted_at IS NULL
        AND  wi.expires_at  > now()
        AND  w.deleted_at   IS NULL
    `).get(token);

    if (!invite) {
      return res.status(404).json({ ok: false, error: 'invite_not_found_or_expired' });
    }

    return res.json({
      ok:             true,
      workspace_name: invite.workspace_name,
      role:           invite.role,
      inviter_name:   invite.inviter_name || null,
      // Return only the first char + domain so the UI can show "Invited as j***@example.com"
      email_hint:     maskEmail(invite.email),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/invites/:token/accept
// Accept a workspace invite — requires the user to be authenticated.
// Switches the session's active workspace to the newly joined one.
// ---------------------------------------------------------------------------
router.post('/:token/accept', async (req, res) => {
  const { token } = req.params;

  // Must be logged in to accept
  if (!req.userId) {
    return res.status(401).json({
      ok:       false,
      error:    'not_authenticated',
      // Let the frontend redirect to login, then back to the accept page
      redirect: `/login.html?next=${encodeURIComponent(`/invite-accept.html?token=${token}`)}`,
    });
  }

  try {
    // Fetch + validate invite
    const invite = await db.prepare(`
      SELECT wi.id, wi.workspace_id, wi.email, wi.role
      FROM   workspace_invites wi
      JOIN   workspaces w ON w.id = wi.workspace_id
      WHERE  wi.token = ?
        AND  wi.accepted_at IS NULL
        AND  wi.expires_at  > now()
        AND  w.deleted_at   IS NULL
    `).get(token);

    if (!invite) {
      return res.status(404).json({ ok: false, error: 'invite_not_found_or_expired' });
    }

    // Email must match the logged-in user's email
    const userRow = await db.prepare(
      'SELECT email FROM user_profiles WHERE user_id = ?'
    ).get(req.userId);
    const userEmail = (userRow?.email || '').toLowerCase();
    const inviteEmail = (invite.email || '').toLowerCase();

    if (userEmail !== inviteEmail) {
      return res.status(403).json({
        ok:    false,
        error: 'email_mismatch',
        // Hint: which email the invite was sent to (masked)
        hint:  maskEmail(invite.email),
      });
    }

    // Accept atomically: insert member row + stamp invite as accepted
    await db.transaction(async tx => {
      // Upsert — if the user is somehow already a member (e.g. double-click), update their role
      await tx.prepare(`
        INSERT INTO workspace_members (workspace_id, user_id, role, invited_by, joined_at)
        VALUES (?, ?, ?, (SELECT invited_by FROM workspace_invites WHERE id = ?), now())
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, joined_at = now()
      `).run(invite.workspace_id, req.userId, invite.role, invite.id);

      await tx.prepare(
        'UPDATE workspace_invites SET accepted_at = now() WHERE id = ?'
      ).run(invite.id);
    });

    // Switch session to the newly joined workspace
    if (req.user && req.session) {
      req.user.tenant_id = invite.workspace_id;
      await new Promise((resolve, reject) =>
        req.session.save(err => err ? reject(err) : resolve())
      );
    }

    return res.json({ ok: true, redirect: '/dashboard.html', workspace_id: invite.workspace_id });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mask an email for display: j***@example.com */
function maskEmail(email) {
  if (!email || !email.includes('@')) return email;
  const [local, domain] = email.split('@');
  const visible = local.slice(0, 1);
  return `${visible}***@${domain}`;
}

module.exports = router;

'use strict';

const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();
const { db }  = require('../db');
const { sendEmail } = require('../emails');
const { getUserPlan } = require('../services/subscription');
const { planHasFeature } = require('../lib/planFeatures');

// requireAuth — only needs an authenticated user, not workspace membership
// (used for workspace creation and listing, which work before a workspace switch)
function requireAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ ok: false, error: 'not_authenticated' });
  next();
}

// requireMemberOf — middleware factory that checks membership in the :id workspace
// (not the session workspace — used for workspace-specific operations)
async function requireMemberOf(req, res, next) {
  try {
    const workspaceId = req.params.id;
    const ws = await db.prepare(
      'SELECT deleted_at FROM workspaces WHERE id = ?'
    ).get(workspaceId);
    if (!ws || ws.deleted_at) return res.status(404).json({ ok: false, error: 'workspace_not_found' });

    const member = await db.prepare(
      'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).get(workspaceId, req.userId);
    if (!member) return res.status(403).json({ ok: false, error: 'not_a_member' });

    req.workspaceRole = member.role;
    next();
  } catch (err) {
    next(err);
  }
}

function requireOwnerOf(req, res, next) {
  if (req.workspaceRole !== 'owner') {
    return res.status(403).json({ ok: false, error: 'owner_required' });
  }
  next();
}

// ---------------------------------------------------------------------------
// GET /api/workspaces
// List all workspaces the authenticated user is a member of.
// ---------------------------------------------------------------------------
router.get('/', requireAuth, async (req, res) => {
  try {
    const workspaces = await db.prepare(`
      SELECT w.id, w.name, w.brand_name, w.brand_logo, w.brand_bg, w.brand_accent, w.brand_text,
             w.grace_expires_at, w.created_at, wm.role,
             (SELECT onboarding_complete FROM profiles
              WHERE workspace_id = w.id AND is_default = true LIMIT 1) AS onboarding_complete
      FROM   workspaces w
      JOIN   workspace_members wm ON wm.workspace_id = w.id
      WHERE  wm.user_id = ? AND w.deleted_at IS NULL
      ORDER  BY wm.created_at ASC
    `).all(req.userId);
    return res.json({ ok: true, workspaces });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/workspaces
// Create a new workspace. Checks plan workspace limit before creating.
// ---------------------------------------------------------------------------
router.post('/', requireAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ ok: false, error: 'name_required' });

  try {
    // Plan limit check
    const sub = await db.prepare(
      'SELECT plan, status, extra_workspaces FROM user_subscriptions WHERE user_id = ?'
    ).get(req.userId);
    const plan = (sub?.status === 'active' || sub?.status === 'trialing') ? (sub.plan || 'free') : 'free';
    const WORKSPACE_LIMITS = { free: 1, solo: 1, pro: 3 };
    const baseLimit = WORKSPACE_LIMITS[plan] ?? 1;
    const limit = plan === 'pro' ? baseLimit + (sub?.extra_workspaces || 0) : baseLimit;

    const owned = await db.prepare(`
      SELECT COUNT(*) AS cnt FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ? AND wm.role = 'owner' AND w.deleted_at IS NULL
    `).get(req.userId);

    if ((owned?.cnt || 0) >= limit) {
      return res.status(403).json({
        ok: false,
        error: 'workspace_limit_reached',
        current: owned?.cnt,
        limit,
        plan,
        canAddOn: plan === 'pro',
        canUpgrade: plan !== 'pro',
      });
    }

    // Create workspace + owner member + blank brand profile
    const wsRow = await db.prepare(
      'INSERT INTO workspaces (name, created_by) VALUES (?, ?) RETURNING id'
    ).get(name.trim(), req.userId);
    const workspaceId = wsRow.id;

    await db.prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, now())'
    ).run(workspaceId, req.userId, 'owner');

    await db.prepare(
      'INSERT INTO profiles (workspace_id, profile_type, display_name, is_default, onboarding_complete) VALUES (?, ?, ?, true, false)'
    ).run(workspaceId, 'brand', name.trim());

    return res.json({ ok: true, workspaceId, redirect: '/workspace-setup.html' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/workspaces/:id
// Rename a workspace (any member can rename).
// ---------------------------------------------------------------------------
router.patch('/:id', requireAuth, requireMemberOf, async (req, res) => {
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ ok: false, error: 'name_required' });

  try {
    await db.prepare(
      'UPDATE workspaces SET name = ?, updated_at = now() WHERE id = ?'
    ).run(name.trim(), req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:id
// Soft-delete a workspace (owner only). Cancels pending scheduled posts.
// ---------------------------------------------------------------------------
router.delete('/:id', requireAuth, requireMemberOf, requireOwnerOf, async (req, res) => {
  const workspaceId = req.params.id;
  try {
    // Cancel all pending scheduled posts for this workspace
    const pending = await db.prepare(
      "SELECT id, bull_job_id FROM scheduled_posts WHERE tenant_id = ? AND status = 'pending'"
    ).all(workspaceId);

    for (const p of pending) {
      if (p.bull_job_id) {
        // Best-effort BullMQ job removal — import scheduler only if available
        try {
          const { removeJob } = require('../services/scheduler');
          if (removeJob) await removeJob(p.bull_job_id);
        } catch { /* non-fatal */ }
      }
    }

    await db.prepare(
      "UPDATE scheduled_posts SET status = 'cancelled', error_message = 'workspace_deleted' WHERE tenant_id = ? AND status = 'pending'"
    ).run(workspaceId);

    // Soft-delete with 30-day purge window
    await db.prepare(
      "UPDATE workspaces SET deleted_at = now(), purge_at = now() + interval '30 days' WHERE id = ?"
    ).run(workspaceId);

    // If deleting the active workspace, switch session to the user's next oldest workspace
    if (req.tenantId === workspaceId) {
      const next = await db.prepare(`
        SELECT workspace_id FROM workspace_members wm
        JOIN workspaces w ON w.id = wm.workspace_id
        WHERE wm.user_id = ? AND wm.workspace_id != ? AND w.deleted_at IS NULL
        ORDER BY wm.created_at ASC LIMIT 1
      `).get(req.userId, workspaceId);
      if (next && req.user) {
        req.user.tenant_id = next.workspace_id;
        await new Promise((resolve, reject) =>
          req.session.save(err => err ? reject(err) : resolve())
        );
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/workspaces/:id/members
// List members + pending invites for a workspace.
// ---------------------------------------------------------------------------
router.get('/:id/members', requireAuth, requireMemberOf, async (req, res) => {
  try {
    const [members, pending_invites] = await Promise.all([
      db.prepare(`
        SELECT wm.user_id, wm.role, wm.joined_at, up.email, up.display_name
        FROM   workspace_members wm
        JOIN   user_profiles up ON up.user_id = wm.user_id
        WHERE  wm.workspace_id = ?
        ORDER  BY wm.created_at ASC
      `).all(req.params.id),
      db.prepare(`
        SELECT id, email, role, invited_by, expires_at, created_at
        FROM   workspace_invites
        WHERE  workspace_id = ? AND accepted_at IS NULL AND expires_at > now()
        ORDER  BY created_at DESC
      `).all(req.params.id),
    ]);
    return res.json({ ok: true, members, pending_invites });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/workspaces/:id/invites
// Invite a user by email (any member can invite).
// Body: { email, role? }   role defaults to 'editor'
// ---------------------------------------------------------------------------
router.post('/:id/invites', requireAuth, requireMemberOf, async (req, res) => {
  const workspaceId = req.params.id;
  const { email, role = 'editor' } = req.body || {};

  if (!email?.trim()) return res.status(400).json({ ok: false, error: 'email_required' });
  if (!['owner', 'editor'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'invalid_role' });
  }

  // Team members require Pro plan
  const inviterPlan = await getUserPlan(req.userId);
  if (!planHasFeature(inviterPlan, 'team_members')) {
    return res.status(403).json({ ok: false, error: 'feature_not_available', feature: 'team_members', requiredPlan: 'pro' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    // Fetch workspace name + inviter display name in parallel
    const [ws, inviter] = await Promise.all([
      db.prepare('SELECT name FROM workspaces WHERE id = ?').get(workspaceId),
      db.prepare('SELECT display_name FROM user_profiles WHERE user_id = ?').get(req.userId),
    ]);

    // Already a member?
    const existingMember = await db.prepare(`
      SELECT wm.user_id FROM workspace_members wm
      JOIN user_profiles up ON up.user_id = wm.user_id
      WHERE wm.workspace_id = ? AND LOWER(up.email) = ?
    `).get(workspaceId, normalizedEmail);
    if (existingMember) {
      return res.status(409).json({ ok: false, error: 'already_a_member' });
    }

    // Pending invite already exists for this email?
    const existingInvite = await db.prepare(`
      SELECT id FROM workspace_invites
      WHERE workspace_id = ? AND LOWER(email) = ? AND accepted_at IS NULL AND expires_at > now()
    `).get(workspaceId, normalizedEmail);
    if (existingInvite) {
      return res.status(409).json({ ok: false, error: 'invite_already_pending' });
    }

    // Create invite
    const token = crypto.randomBytes(32).toString('hex');
    const result = await db.prepare(`
      INSERT INTO workspace_invites (workspace_id, email, role, token, invited_by, expires_at)
      VALUES (?, ?, ?, ?, ?, now() + interval '7 days')
      RETURNING id, email, role, expires_at
    `).get(workspaceId, normalizedEmail, role, token, req.userId);

    // Send invite email (fire-and-forget — never let email failure block the response)
    const appUrl = (process.env.APP_URL || 'https://app.scouthook.com').replace(/\/$/, '');
    sendEmail('workspace-invite', normalizedEmail, {
      inviter_name:   inviter?.display_name || 'A teammate',
      workspace_name: ws?.name || 'a workspace',
      role,
      accept_url:     `${appUrl}/invite-accept.html?token=${token}`,
      expires_in_days: '7',
    }).catch(e => console.warn('[workspaces/invites] email send failed (non-fatal):', e.message));

    return res.status(201).json({ ok: true, invite: result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:id/invites/:inviteId
// Revoke a pending invite (any member can revoke).
// ---------------------------------------------------------------------------
router.delete('/:id/invites/:inviteId', requireAuth, requireMemberOf, async (req, res) => {
  try {
    const result = await db.prepare(`
      DELETE FROM workspace_invites
      WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL
    `).run(Number(req.params.inviteId), req.params.id);

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: 'invite_not_found' });
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:id/members/:userId
// Remove a member (owner only; cannot remove self if last owner).
// ---------------------------------------------------------------------------
router.delete('/:id/members/:userId', requireAuth, requireMemberOf, requireOwnerOf, async (req, res) => {
  const { id: workspaceId, userId: targetUserId } = req.params;
  try {
    if (targetUserId === req.userId) {
      return res.status(400).json({ ok: false, error: 'cannot_remove_self' });
    }
    await db.prepare(
      'DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).run(workspaceId, targetUserId);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/workspaces/:id/switch
// Switch the active workspace in the session. Returns redirect URL.
// ---------------------------------------------------------------------------
router.post('/:id/switch', requireAuth, requireMemberOf, async (req, res) => {
  const workspaceId = req.params.id;
  try {
    req.user.tenant_id = workspaceId;
    await Promise.all([
      new Promise((resolve, reject) =>
        req.session.save(err => err ? reject(err) : resolve())
      ),
      db.prepare(
        'UPDATE user_profiles SET last_active_workspace_id = ? WHERE user_id = ?'
      ).run(workspaceId, req.userId),
    ]);
    return res.json({ ok: true, redirect: '/dashboard.html' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/workspaces/profiles
// List profiles for the active session workspace (brand first, then persons).
// Used by the generate page "Creating for" selector.
// ---------------------------------------------------------------------------
router.get('/profiles', requireAuth, async (req, res) => {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(401).json({ ok: false, error: 'no_workspace' });
  try {
    const profiles = await db.prepare(`
      SELECT p.id, p.profile_type, p.display_name, p.is_default, p.avatar_url,
             p.voice_profile_completion_pct,
             (SELECT COUNT(*) FROM linkedin_connections lc WHERE lc.profile_id = p.id) AS connection_count
      FROM profiles p
      WHERE p.workspace_id = ?
      ORDER BY p.is_default DESC, p.created_at ASC
    `).all(tenantId);
    return res.json({ ok: true, profiles });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

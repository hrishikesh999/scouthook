'use strict';

const express    = require('express');
const crypto     = require('crypto');
const bcrypt     = require('bcryptjs');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const router     = express.Router();
const { db }     = require('../db');
const { sendEmail } = require('../emails');
const { seedTrialSubscription } = require('../services/subscription');

const APP_URL = process.env.APP_URL || '';

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidEmail(str) {
  return typeof str === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str.trim());
}

function isValidPassword(str) {
  return typeof str === 'string' && str.length >= 8;
}

async function createPersonalWorkspaceForUser(userId, displayName) {
  const wsRow = await db.prepare(
    'INSERT INTO workspaces (name, created_by) VALUES (?, ?) RETURNING id'
  ).get(`${displayName}'s Workspace`, userId);
  const workspaceId = wsRow.id;
  await db.prepare(
    'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, now())'
  ).run(workspaceId, userId, 'owner');
  await db.prepare(
    'INSERT INTO profiles (workspace_id, profile_type, display_name, is_default, onboarding_complete) VALUES (?, ?, ?, true, false)'
  ).run(workspaceId, 'brand', displayName);
  return workspaceId;
}

async function establishSession(req, userId, workspaceId) {
  await new Promise((resolve, reject) =>
    req.session.regenerate(err => err ? reject(err) : resolve())
  );
  req.session.passport = {
    user: {
      provider:    'email',
      user_id:     userId,
      tenant_id:   workspaceId,
      displayName: '',
      email:       '',
    },
  };
  await new Promise((resolve, reject) =>
    req.session.save(err => err ? reject(err) : resolve())
  );
}

// ── Rate limiters ─────────────────────────────────────────────────────────────

// 5 POST attempts per 15 minutes per IP for login
const loginLimiter = rateLimit({
  windowMs:      15 * 60 * 1000,
  max:           5,
  keyGenerator:  (req, res) => ipKeyGenerator(req, res),
  skipSuccessfulRequests: true,
  handler:       (req, res) => res.status(429).json({ ok: false, error: 'too_many_attempts' }),
});

// 3 resend-verification emails per 60 minutes per email
const resendLimiter = rateLimit({
  windowMs:      60 * 60 * 1000,
  max:           3,
  keyGenerator:  (req, res) => (req.body?.email || ipKeyGenerator(req, res)),
  handler:       (req, res) => res.status(429).json({ ok: false, error: 'too_many_resend_attempts' }),
});

// ── POST /auth/signup ────────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || typeof name !== 'string' || name.trim().length < 1) {
      return res.status(400).json({ ok: false, error: 'name_required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: 'invalid_email' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ ok: false, error: 'password_too_short' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const displayName     = name.trim();

    // Check if email already registered (any auth method)
    const existing = await db.prepare(
      "SELECT user_id FROM auth_providers WHERE provider = 'email' AND provider_id = ? LIMIT 1"
    ).get(normalizedEmail);
    if (existing) {
      return res.status(409).json({ ok: false, error: 'email_already_registered' });
    }

    // Hash password + generate verify token
    const [credentialHash, verifyToken] = await Promise.all([
      bcrypt.hash(password, 12),
      Promise.resolve(crypto.randomBytes(32).toString('hex')),
    ]);
    const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const newUserId       = `user_${crypto.randomUUID()}`;

    // Insert auth_providers + user_profiles atomically
    await db.prepare(`
      INSERT INTO user_profiles (user_id, email, display_name)
      VALUES (?, ?, ?)
    `).run(newUserId, normalizedEmail, displayName);

    await db.prepare(`
      INSERT INTO auth_providers
        (user_id, provider, provider_id, credential_hash, verify_token, verify_expires_at)
      VALUES (?, 'email', ?, ?, ?, ?)
    `).run(newUserId, normalizedEmail, credentialHash, verifyToken, verifyExpiresAt.toISOString());

    // Send verification email (fire-and-forget — don't block the response)
    sendEmail('verify-email', normalizedEmail, {
      display_name: displayName,
      verify_url:   `${APP_URL}/auth/verify-email?token=${verifyToken}`,
    }).catch(err => console.error('[email-auth] verify email failed:', err.message));

    return res.json({ ok: true, redirect: '/check-email.html?reason=signup' });
  } catch (err) {
    console.error('[email-auth] signup error:', err.message);
    return res.status(500).json({ ok: false, error: 'signup_failed' });
  }
});

// ── GET /auth/verify-email ───────────────────────────────────────────────────
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.redirect('/login.html?error=invalid_or_expired_token');

    const row = await db.prepare(`
      SELECT ap.*, up.email, up.display_name
      FROM auth_providers ap
      JOIN user_profiles up ON up.user_id = ap.user_id
      WHERE ap.verify_token = ? AND ap.verify_expires_at > now()
      LIMIT 1
    `).get(token);

    if (!row) return res.redirect('/login.html?error=invalid_or_expired_token');

    // Mark verified
    await db.prepare(`
      UPDATE auth_providers
      SET verified_at = now(), verify_token = NULL, verify_expires_at = NULL
      WHERE user_id = ? AND provider = 'email'
    `).run(row.user_id);

    // Resolve or create workspace
    const membership = await db.prepare(
      'SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1'
    ).get(row.user_id);

    let workspaceId;
    if (membership) {
      workspaceId = membership.workspace_id;
    } else {
      workspaceId = await createPersonalWorkspaceForUser(row.user_id, row.display_name);
      seedTrialSubscription(row.user_id).catch(() => {});
      // Welcome email
      sendEmail('welcome', row.email, {
        name:    row.display_name.split(' ')[0] || row.display_name,
        app_url: APP_URL,
      }).catch(() => {});
      require('../services/mailerlite').addFreeSubscriber(row.email, row.display_name).catch(() => {});
    }

    // Create session
    await establishSession(req, row.user_id, workspaceId);

    // Check onboarding state
    const brandProfile = await db.prepare(`
      SELECT onboarding_complete FROM profiles
      WHERE workspace_id = ? AND profile_type = 'brand' AND is_default = true
      LIMIT 1
    `).get(workspaceId);

    const dest = brandProfile?.onboarding_complete ? '/dashboard.html' : '/onboarding.html';
    return res.redirect(dest);
  } catch (err) {
    console.error('[email-auth] verify-email error:', err.message);
    return res.redirect('/login.html?error=verification_failed');
  }
});

// ── POST /auth/login ─────────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!isValidEmail(email) || !isValidPassword(password)) {
      return res.status(400).json({ ok: false, error: 'invalid_credentials' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const row = await db.prepare(`
      SELECT ap.*, up.display_name
      FROM auth_providers ap
      JOIN user_profiles up ON up.user_id = ap.user_id
      WHERE ap.provider = 'email' AND ap.provider_id = ?
      LIMIT 1
    `).get(normalizedEmail);

    if (!row) {
      return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }
    if (!row.verified_at) {
      return res.status(401).json({ ok: false, error: 'email_not_verified' });
    }

    const valid = await bcrypt.compare(password, row.credential_hash);
    if (!valid) {
      return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }

    // Resolve workspace — prefer last active, fall back to oldest non-deleted
    let workspaceId;
    try {
      const profile = await db.prepare(
        'SELECT last_active_workspace_id FROM user_profiles WHERE user_id = ?'
      ).get(row.user_id);
      if (profile?.last_active_workspace_id) {
        const ws = await db.prepare(
          'SELECT id FROM workspaces WHERE id = ? AND deleted_at IS NULL'
        ).get(profile.last_active_workspace_id);
        if (ws) workspaceId = ws.id;
      }
    } catch { /* last_active_workspace_id column missing — migration 038 not yet applied */ }

    if (!workspaceId) {
      const membership = await db.prepare(
        `SELECT wm.workspace_id FROM workspace_members wm
         JOIN workspaces w ON w.id = wm.workspace_id
         WHERE wm.user_id = ? AND w.deleted_at IS NULL
         ORDER BY wm.created_at ASC LIMIT 1`
      ).get(row.user_id);
      if (membership) {
        workspaceId = membership.workspace_id;
      } else {
        workspaceId = await createPersonalWorkspaceForUser(row.user_id, row.display_name);
      }
    }

    await establishSession(req, row.user_id, workspaceId);

    return res.json({ ok: true, redirect: '/dashboard.html' });
  } catch (err) {
    console.error('[email-auth] login error:', err.message);
    return res.status(500).json({ ok: false, error: 'login_failed' });
  }
});

// ── POST /auth/forgot-password ───────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    // Always return 200 — prevent email enumeration
    const normalizedEmail = isValidEmail(email) ? email.trim().toLowerCase() : null;

    if (normalizedEmail) {
      const row = await db.prepare(`
        SELECT user_id FROM auth_providers
        WHERE provider = 'email' AND provider_id = ? AND verified_at IS NOT NULL
        LIMIT 1
      `).get(normalizedEmail);

      if (row) {
        const resetToken   = crypto.randomBytes(32).toString('hex');
        const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await db.prepare(`
          UPDATE auth_providers
          SET reset_token = ?, reset_expires_at = ?
          WHERE user_id = ? AND provider = 'email'
        `).run(resetToken, resetExpires.toISOString(), row.user_id);

        sendEmail('reset-password', normalizedEmail, {
          reset_url: `${APP_URL}/reset-password.html?token=${resetToken}`,
        }).catch(err => console.error('[email-auth] reset email failed:', err.message));
      }
    }

    return res.json({ ok: true, redirect: '/check-email.html?reason=reset' });
  } catch (err) {
    console.error('[email-auth] forgot-password error:', err.message);
    return res.json({ ok: true, redirect: '/check-email.html?reason=reset' });
  }
});

// ── POST /auth/reset-password ────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: 'token_required' });
    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ ok: false, error: 'password_too_short' });
    }

    const row = await db.prepare(`
      SELECT ap.user_id, up.display_name, up.email
      FROM auth_providers ap
      JOIN user_profiles up ON up.user_id = ap.user_id
      WHERE ap.reset_token = ? AND ap.reset_expires_at > now()
      LIMIT 1
    `).get(token);

    if (!row) return res.status(400).json({ ok: false, error: 'invalid_or_expired_token' });

    const credentialHash = await bcrypt.hash(newPassword, 12);
    await db.prepare(`
      UPDATE auth_providers
      SET credential_hash = ?, reset_token = NULL, reset_expires_at = NULL
      WHERE user_id = ? AND provider = 'email'
    `).run(credentialHash, row.user_id);

    // Establish session on successful reset — prefer last active workspace
    let workspaceId;
    try {
      const upRow = await db.prepare(
        'SELECT last_active_workspace_id FROM user_profiles WHERE user_id = ?'
      ).get(row.user_id);
      if (upRow?.last_active_workspace_id) {
        const ws = await db.prepare(
          'SELECT id FROM workspaces WHERE id = ? AND deleted_at IS NULL'
        ).get(upRow.last_active_workspace_id);
        if (ws) workspaceId = ws.id;
      }
    } catch { /* last_active_workspace_id column missing — migration 038 not yet applied */ }

    if (!workspaceId) {
      const membership = await db.prepare(
        `SELECT wm.workspace_id FROM workspace_members wm
         JOIN workspaces w ON w.id = wm.workspace_id
         WHERE wm.user_id = ? AND w.deleted_at IS NULL
         ORDER BY wm.created_at ASC LIMIT 1`
      ).get(row.user_id);
      if (membership) {
        workspaceId = membership.workspace_id;
      } else {
        workspaceId = await createPersonalWorkspaceForUser(row.user_id, row.display_name);
      }
    }

    await establishSession(req, row.user_id, workspaceId);

    return res.json({ ok: true, redirect: '/dashboard.html' });
  } catch (err) {
    console.error('[email-auth] reset-password error:', err.message);
    return res.status(500).json({ ok: false, error: 'reset_failed' });
  }
});

// ── POST /auth/resend-verification ───────────────────────────────────────────
router.post('/resend-verification', resendLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    // Always return 200 — prevent enumeration
    const normalizedEmail = isValidEmail(email) ? email.trim().toLowerCase() : null;

    if (normalizedEmail) {
      const row = await db.prepare(`
        SELECT ap.user_id, up.display_name
        FROM auth_providers ap
        JOIN user_profiles up ON up.user_id = ap.user_id
        WHERE ap.provider = 'email' AND ap.provider_id = ? AND ap.verified_at IS NULL
        LIMIT 1
      `).get(normalizedEmail);

      if (row) {
        const verifyToken     = crypto.randomBytes(32).toString('hex');
        const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        await db.prepare(`
          UPDATE auth_providers
          SET verify_token = ?, verify_expires_at = ?
          WHERE user_id = ? AND provider = 'email'
        `).run(verifyToken, verifyExpiresAt.toISOString(), row.user_id);

        sendEmail('verify-email', normalizedEmail, {
          display_name: row.display_name,
          verify_url:   `${APP_URL}/auth/verify-email?token=${verifyToken}`,
        }).catch(() => {});
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[email-auth] resend-verification error:', err.message);
    return res.json({ ok: true });
  }
});

module.exports = router;

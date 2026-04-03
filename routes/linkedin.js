'use strict';

const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();
const { db, getSetting } = require('../db');
const { storeTokens, getValidAccessToken } = require('../services/linkedinOAuth');
const { publishNow } = require('../services/linkedinPublisher');
const { addScheduledJob, removeScheduledJob } = require('../services/scheduler');

// ---------------------------------------------------------------------------
// In-memory OAuth state store — CSRF protection for the OAuth redirect
// Each entry: { userId, tenantId } keyed by random UUID, auto-expires after 10min
// ---------------------------------------------------------------------------
const oauthStates = new Map();

function setOAuthState(state, data) {
  oauthStates.set(state, data);
  setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// GET /api/linkedin/status
// Lightweight check — used by the UI on page load
// ---------------------------------------------------------------------------
router.get('/status', (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;

  if (!userId) return res.json({ ok: true, connected: false, name: null });

  const row = db.prepare(
    'SELECT linkedin_name FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
  ).get(userId, tenantId);

  return res.json({
    ok:        true,
    connected: !!row,
    name:      row?.linkedin_name || null,
  });
});

// ---------------------------------------------------------------------------
// GET /api/linkedin/connect
// Initiates OAuth flow — redirects to LinkedIn authorization page
// ---------------------------------------------------------------------------
router.get('/connect', (req, res) => {
  // Accept userId from header middleware OR _uid query param (browser redirect can't set headers)
  const userId   = req.userId   || req.query._uid;
  const tenantId = req.tenantId || req.query._tid || 'default';

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const clientId    = getSetting('linkedin_client_id');
  const redirectUri = getSetting('linkedin_redirect_uri');

  if (!clientId || !redirectUri) {
    return res.status(500).json({ ok: false, error: 'linkedin_not_configured' });
  }

  const state = crypto.randomUUID();
  setOAuthState(state, { userId, tenantId });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  redirectUri,
    state,
    scope:         'openid profile email w_member_social',
  });

  res.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params}`);
});

// ---------------------------------------------------------------------------
// GET /api/linkedin/callback
// OAuth callback — exchanges code for tokens, stores them, redirects to app
// ---------------------------------------------------------------------------
router.get('/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    return res.redirect(`/?linkedin_error=${encodeURIComponent(oauthError)}`);
  }

  if (!state || !oauthStates.has(state)) {
    return res.redirect('/?linkedin_error=invalid_state');
  }

  const { userId, tenantId } = oauthStates.get(state);
  oauthStates.delete(state);

  try {
    const clientId     = getSetting('linkedin_client_id');
    const clientSecret = getSetting('linkedin_client_secret');
    const redirectUri  = getSetting('linkedin_redirect_uri');

    // Exchange code for tokens
    const tokenParams = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  redirectUri,
      client_id:     clientId,
      client_secret: clientSecret,
    });

    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    tokenParams.toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error('[linkedin/callback] Token exchange failed:', text);
      return res.redirect('/?linkedin_error=token_exchange_failed');
    }

    const tokens = await tokenRes.json();

    // Fetch LinkedIn profile via OpenID Connect userinfo endpoint
    const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` },
    });

    let linkedin_user_id = null;
    let linkedin_name    = null;
    let linkedin_photo   = null;

    if (profileRes.ok) {
      const profile = await profileRes.json();
      // OpenID Connect: sub = LinkedIn member ID, name = full name, picture = photo URL
      linkedin_user_id = profile.sub;
      linkedin_name    = profile.name || `${profile.given_name || ''} ${profile.family_name || ''}`.trim() || null;
      linkedin_photo   = profile.picture || null;
    } else {
      const text = await profileRes.text();
      console.error('[linkedin/callback] userinfo fetch failed:', profileRes.status, text);
    }

    storeTokens(userId, tenantId, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      expires_in: tokens.expires_in,
      linkedin_user_id,
      linkedin_name,
      linkedin_photo,
    });

    console.log(`[linkedin/callback] Connected user=${userId} as ${linkedin_name} (${linkedin_user_id})`);
    res.redirect('/?linkedin_connected=true');

  } catch (err) {
    console.error('[linkedin/callback] Error:', err.message);
    res.redirect(`/?linkedin_error=${encodeURIComponent(err.message)}`);
  }
});

// ---------------------------------------------------------------------------
// POST /api/linkedin/publish
// Publish a post immediately
// Body: { content }
// ---------------------------------------------------------------------------
router.post('/publish', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  const { content } = req.body;

  if (!userId)  return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!content?.trim()) return res.status(400).json({ ok: false, error: 'missing_content' });
  if (content.length > 3000) return res.status(400).json({ ok: false, error: 'content_too_long' });

  try {
    const result = await publishNow(userId, tenantId, content.trim());
    return res.json({ ok: true, linkedin_post_id: result.linkedin_post_id });
  } catch (err) {
    if (err.message === 'not_connected')      return res.status(401).json({ ok: false, error: 'not_connected' });
    if (err.message === 'reconnect_required') return res.status(401).json({ ok: false, error: 'reconnect_required' });
    if (err.message === 'rate_limit_exceeded') return res.status(429).json({ ok: false, error: 'rate_limit_exceeded' });
    console.error('[linkedin/publish] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/linkedin/schedule
// Schedule a post for future publishing
// Body: { content, scheduled_for (ISO datetime string) }
// ---------------------------------------------------------------------------
router.post('/schedule', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  const { content, scheduled_for, post_id } = req.body;

  if (!userId)         return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!content?.trim()) return res.status(400).json({ ok: false, error: 'missing_content' });
  if (!scheduled_for)  return res.status(400).json({ ok: false, error: 'missing_scheduled_for' });

  const scheduledDate = new Date(scheduled_for);
  if (isNaN(scheduledDate) || scheduledDate <= new Date()) {
    return res.status(400).json({ ok: false, error: 'scheduled_for_must_be_future' });
  }

  // Verify user is connected
  const tokenRow = db.prepare(
    'SELECT id FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
  ).get(userId, tenantId);
  if (!tokenRow) return res.status(401).json({ ok: false, error: 'not_connected' });

  try {
    const result = db.prepare(`
      INSERT INTO scheduled_posts (user_id, tenant_id, post_id, content, scheduled_for, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(userId, tenantId, post_id || null, content.trim(), scheduledDate.toISOString());

    const scheduledPostId = result.lastInsertRowid;

    try {
      await addScheduledJob(scheduledPostId, scheduledDate);
    } catch (schedulerErr) {
      // Scheduler not available — post is still saved, won't auto-publish
      console.warn('[linkedin/schedule] Scheduler unavailable:', schedulerErr.message);
    }

    return res.json({ ok: true, scheduled_post_id: scheduledPostId });
  } catch (err) {
    console.error('[linkedin/schedule] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/linkedin/scheduled
// List pending scheduled posts for the current user
// ---------------------------------------------------------------------------
router.get('/scheduled', (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const posts = db.prepare(`
    SELECT id, content, scheduled_for, status, linkedin_post_id, error_message, attempts, created_at
    FROM scheduled_posts
    WHERE user_id = ? AND tenant_id = ? AND status IN ('pending', 'processing')
    ORDER BY scheduled_for ASC
  `).all(userId, tenantId);

  return res.json({ ok: true, posts });
});

// ---------------------------------------------------------------------------
// DELETE /api/linkedin/scheduled/:id
// Cancel a scheduled post
// ---------------------------------------------------------------------------
router.delete('/scheduled/:id', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  const { id }   = req.params;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const row = db.prepare(
    'SELECT id, status FROM scheduled_posts WHERE id = ? AND user_id = ? AND tenant_id = ?'
  ).get(id, userId, tenantId);

  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  if (!['pending', 'processing'].includes(row.status)) {
    return res.status(400).json({ ok: false, error: 'cannot_cancel', status: row.status });
  }

  db.prepare(
    `UPDATE scheduled_posts SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(id);

  await removeScheduledJob(Number(id));

  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/linkedin/disconnect
// Remove LinkedIn connection for the current user
// ---------------------------------------------------------------------------
router.post('/disconnect', (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  db.prepare(
    'DELETE FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
  ).run(userId, tenantId);

  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/linkedin/user-data
// GDPR compliance — delete ALL user data across all tables
// Required for LinkedIn API approval
// ---------------------------------------------------------------------------
router.delete('/user-data', (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const deleteAll = db.transaction(() => {
    db.prepare('DELETE FROM generated_posts  WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
    db.prepare('DELETE FROM generation_runs  WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
    db.prepare('DELETE FROM copy_events      WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
    db.prepare('DELETE FROM linkedin_tokens  WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
    db.prepare('DELETE FROM scheduled_posts  WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
    db.prepare('DELETE FROM user_profiles    WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
    db.prepare('DELETE FROM tenant_settings  WHERE tenant_id = ?').run(tenantId);
  });

  deleteAll();

  console.log(`[linkedin/user-data] All data deleted for user=${userId} tenant=${tenantId}`);
  return res.json({ ok: true });
});

module.exports = router;

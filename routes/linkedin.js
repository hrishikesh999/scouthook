'use strict';

const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();
const { db, getSetting } = require('../db');
const { storeTokens, getValidAccessToken } = require('../services/linkedinOAuth');
const { publishNow } = require('../services/linkedinPublisher');
const { addScheduledJob, removeScheduledJob } = require('../services/scheduler');
const { syncPostMetrics, RateLimitError } = require('../services/linkedinMetrics');

const REVIEW_MODE = process.env.REVIEW_MODE === '1';

function setReviewSessionCookie(res, payload) {
  // Must match the signer in server.js (HMAC SHA-256 with SESSION_SECRET)
  const crypto = require('crypto');
  const secret = process.env.SESSION_SECRET || null;
  if (!secret) throw new Error('SESSION_SECRET not set');

  function base64urlEncode(input) {
    return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  const body = base64urlEncode(JSON.stringify(payload));
  const sig = base64urlEncode(crypto.createHmac('sha256', secret).update(body).digest());
  const token = `${body}.${sig}`;

  const isProd = process.env.NODE_ENV === 'production';
  const cookie = [
    `sh_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    isProd ? 'Secure' : null,
    // 30 days
    `Max-Age=${60 * 60 * 24 * 30}`,
  ].filter(Boolean).join('; ');

  res.setHeader('Set-Cookie', cookie);
}

function clearReviewSessionCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  const cookie = [
    'sh_session=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    isProd ? 'Secure' : null,
    'Max-Age=0',
  ].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', cookie);
}

/**
 * Cancel a pending/processing scheduled row: DB updates + remove Bull job.
 * @returns {Promise<{ ok: true } | { ok: false, error: string, status?: string }>}
 */
async function cancelScheduledPostById(userId, tenantId, scheduledPostId) {
  const row = db.prepare(
    'SELECT id, status, post_id FROM scheduled_posts WHERE id = ? AND user_id = ? AND tenant_id = ?'
  ).get(scheduledPostId, userId, tenantId);

  if (!row) return { ok: false, error: 'not_found' };
  if (!['pending', 'processing'].includes(row.status)) {
    return { ok: false, error: 'cannot_cancel', status: row.status };
  }

  db.prepare(
    `UPDATE scheduled_posts SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(scheduledPostId);

  if (row.post_id) {
    db.prepare(`
      UPDATE generated_posts
      SET status = 'draft'
      WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'scheduled'
    `).run(row.post_id, userId, tenantId);
  }

  await removeScheduledJob(Number(scheduledPostId));
  return { ok: true };
}

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

  if (REVIEW_MODE) {
    const prof = req.linkedinProfile || null;
    if (!prof?.sub) return res.json({ ok: true, connected: false, name: null, photo_url: null });
    return res.json({
      ok: true,
      connected: true,
      name: prof.name || null,
      photo_url: prof.picture || null,
    });
  }

  if (!userId) return res.json({ ok: true, connected: false, name: null, photo_url: null });

  const row = db.prepare(
    'SELECT linkedin_name, linkedin_photo FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
  ).get(userId, tenantId);

  return res.json({
    ok:        true,
    connected: !!row,
    name:      row?.linkedin_name || null,
    photo_url: row?.linkedin_photo?.trim() || null,
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

  const clientId    = getSetting('linkedin_client_id');
  const redirectUri = getSetting('linkedin_redirect_uri');

  if (!clientId || !redirectUri) {
    return res.status(500).json({ ok: false, error: 'linkedin_not_configured' });
  }

  const state = crypto.randomUUID();
  setOAuthState(state, { userId: userId || null, tenantId });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  redirectUri,
    state,
    // Review-mode is sign-in only (no posting scope)
    scope:         REVIEW_MODE ? 'openid profile' : 'openid profile email w_member_social',
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
    return res.redirect(`/dashboard.html?linkedin_error=${encodeURIComponent(oauthError)}`);
  }

  if (!state || !oauthStates.has(state)) {
    return res.redirect('/dashboard.html?linkedin_error=invalid_state');
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
      return res.redirect('/dashboard.html?linkedin_error=token_exchange_failed');
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

    if (REVIEW_MODE) {
      // In review-mode we do NOT persist access/refresh tokens (no posting).
      // We only create a signed session for the browser.
      setReviewSessionCookie(res, {
        sub: linkedin_user_id,
        name: linkedin_name,
        picture: linkedin_photo,
        tid: tenantId || 'default',
        iat: Date.now(),
      });

      console.log(`[linkedin/callback] Review-mode sign-in user=${linkedin_user_id} name=${linkedin_name}`);
      return res.redirect('/dashboard.html?linkedin_signed_in=true');
    }

    // Fallback: some accounts/apps don't receive OIDC `picture` reliably.
    // Try LinkedIn REST `me` with profilePicture projection and LinkedIn-Version header.
    if (!linkedin_photo) {
      try {
        const meRes = await fetch(
          'https://api.linkedin.com/v2/me?projection=(localizedFirstName,localizedLastName,profilePicture(displayImage~:playableStreams))',
          {
            headers: {
              'Authorization': `Bearer ${tokens.access_token}`,
              'LinkedIn-Version': '202603',
            },
          }
        );

        if (meRes.ok) {
          const me = await meRes.json();
          if (!linkedin_name) {
            linkedin_name = `${me.localizedFirstName || ''} ${me.localizedLastName || ''}`.trim() || null;
          }

          const streams = me?.profilePicture?.['displayImage~']?.elements || [];
          const best = streams
            .map(el => ({
              url: el?.identifiers?.[0]?.identifier || null,
              area: (el?.data?.['com.linkedin.digitalmedia.mediaartifact.StillImage']?.storageSize?.width || 0) *
                (el?.data?.['com.linkedin.digitalmedia.mediaartifact.StillImage']?.storageSize?.height || 0),
            }))
            .filter(x => !!x.url)
            .sort((a, b) => b.area - a.area)[0];

          if (best?.url) linkedin_photo = best.url;
        } else {
          const text = await meRes.text();
          console.warn('[linkedin/callback] me fallback failed:', meRes.status, text);
        }
      } catch (e) {
        console.warn('[linkedin/callback] me fallback error:', e.message);
      }
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
    res.redirect('/dashboard.html?linkedin_connected=true');

  } catch (err) {
    console.error('[linkedin/callback] Error:', err.message);
    res.redirect(`/dashboard.html?linkedin_error=${encodeURIComponent(err.message)}`);
  }
});

// ---------------------------------------------------------------------------
// Review-mode: block automation/analytics endpoints
// ---------------------------------------------------------------------------
function blockedInReviewMode(req, res, next) {
  if (!REVIEW_MODE) return next();
  return res.status(404).json({ ok: false, error: 'not_available_in_review_mode' });
}

// ---------------------------------------------------------------------------
// POST /api/linkedin/publish
// Publish a post immediately
// Body: { content }
// ---------------------------------------------------------------------------
router.post('/publish', blockedInReviewMode, async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  const { content, image_url, carousel_pdf_url, postId } = req.body;

  if (!userId)  return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!content?.trim()) return res.status(400).json({ ok: false, error: 'missing_content' });
  if (content.length > 3000) return res.status(400).json({ ok: false, error: 'content_too_long' });
  if (image_url && typeof image_url !== 'string') return res.status(400).json({ ok: false, error: 'invalid_image_url' });
  if (carousel_pdf_url && typeof carousel_pdf_url !== 'string') {
    return res.status(400).json({ ok: false, error: 'invalid_carousel_pdf_url' });
  }

  if (postId) {
    const gp = db.prepare(
      'SELECT status FROM generated_posts WHERE id = ? AND user_id = ? AND tenant_id = ?'
    ).get(postId, userId, tenantId);
    if (!gp) return res.status(404).json({ ok: false, error: 'post_not_found' });
    if (gp.status === 'scheduled') {
      return res.status(409).json({ ok: false, error: 'publish_blocked_scheduled' });
    }
  }

  try {
    const result = await publishNow(userId, tenantId, content.trim(), {
      carousel_pdf_url: carousel_pdf_url?.trim() || null,
      image_url: image_url?.trim() || null,
    });

    // Stamp the originating draft as published and persist the LinkedIn share ID
    if (postId) {
      const assetType = carousel_pdf_url ? 'carousel' : image_url ? 'image' : null;
      db.prepare(`
        UPDATE generated_posts
        SET status = 'published', published_at = CURRENT_TIMESTAMP, asset_type = ?
        WHERE id = ? AND user_id = ? AND tenant_id = ?
      `).run(assetType, postId, userId, tenantId);

      if (result.linkedin_post_id) {
        db.prepare(`UPDATE generated_posts SET linkedin_post_id = ? WHERE id = ?`)
          .run(result.linkedin_post_id, postId);
      }
    }

    return res.json({ ok: true, linkedin_post_id: result.linkedin_post_id });
  } catch (err) {
    if (err.message === 'not_connected')      return res.status(401).json({ ok: false, error: 'not_connected' });
    if (err.message === 'reconnect_required') return res.status(401).json({ ok: false, error: 'reconnect_required' });
    if (err.message === 'rate_limit_exceeded') return res.status(429).json({ ok: false, error: 'rate_limit_exceeded' });
    if (err.message === 'invalid_image_url') return res.status(400).json({ ok: false, error: 'invalid_image_url' });
    if (err.message === 'invalid_carousel_pdf_url') {
      return res.status(400).json({ ok: false, error: 'invalid_carousel_pdf_url' });
    }
    if (err.message === 'linkedin_image_not_ready' || err.message === 'linkedin_image_processing_failed') {
      return res.status(502).json({ ok: false, error: err.message });
    }
    console.error('[linkedin/publish] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/linkedin/schedule
// Schedule a post for future publishing
// Body: { content, scheduled_for (ISO datetime string) }
// ---------------------------------------------------------------------------
router.post('/schedule', blockedInReviewMode, async (req, res) => {
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

    // Keep scheduled posts out of the Drafts list (GET /api/posts?status=draft)
    if (post_id) {
      db.prepare(`
        UPDATE generated_posts
        SET status = 'scheduled'
        WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'draft'
      `).run(post_id, userId, tenantId);
    }

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
router.get('/scheduled', blockedInReviewMode, (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const posts = db.prepare(`
    SELECT sp.id, sp.content, sp.scheduled_for, sp.status,
           sp.linkedin_post_id, sp.error_message, sp.attempts, sp.created_at,
           sp.post_id, gp.format_slug
    FROM   scheduled_posts sp
    LEFT JOIN generated_posts gp ON sp.post_id = gp.id
    WHERE  sp.user_id = ? AND sp.tenant_id = ? AND sp.status IN ('pending', 'processing')
    ORDER  BY sp.scheduled_for ASC
  `).all(userId, tenantId);

  return res.json({ ok: true, posts });
});

// ---------------------------------------------------------------------------
// DELETE /api/linkedin/scheduled/:id
// Cancel a scheduled post
// ---------------------------------------------------------------------------
router.delete('/scheduled/:id', blockedInReviewMode, async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  const { id }   = req.params;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const result = await cancelScheduledPostById(userId, tenantId, Number(id));
  if (!result.ok) {
    if (result.error === 'not_found') return res.status(404).json({ ok: false, error: 'not_found' });
    return res.status(400).json({ ok: false, error: result.error, status: result.status });
  }

  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/linkedin/scheduled/pause-by-post
// Cancel schedule by generated_posts id — used from generate.html (Pause to edit)
// Body: { post_id }
// ---------------------------------------------------------------------------
router.post('/scheduled/pause-by-post', blockedInReviewMode, async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  const postId   = req.body?.post_id != null ? Number(req.body.post_id) : NaN;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!Number.isFinite(postId)) return res.status(400).json({ ok: false, error: 'invalid_post_id' });

  const schedRow = db.prepare(`
    SELECT id FROM scheduled_posts
    WHERE post_id = ? AND user_id = ? AND tenant_id = ? AND status IN ('pending', 'processing')
  `).get(postId, userId, tenantId);

  if (!schedRow) {
    const gp = db.prepare(
      'SELECT id, status FROM generated_posts WHERE id = ? AND user_id = ? AND tenant_id = ?'
    ).get(postId, userId, tenantId);
    if (!gp) return res.status(404).json({ ok: false, error: 'post_not_found' });
    return res.status(409).json({ ok: false, error: 'no_active_schedule', status: gp.status });
  }

  const result = await cancelScheduledPostById(userId, tenantId, schedRow.id);
  if (!result.ok) {
    if (result.error === 'not_found') return res.status(404).json({ ok: false, error: 'not_found' });
    return res.status(400).json({ ok: false, error: result.error, status: result.status });
  }

  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/linkedin/disconnect
// Remove LinkedIn connection for the current user
// ---------------------------------------------------------------------------
router.post('/disconnect', (req, res) => {
  if (REVIEW_MODE) {
    clearReviewSessionCookie(res);
    return res.json({ ok: true });
  }

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

// ---------------------------------------------------------------------------
// POST /api/linkedin/sync-metrics
// Fetches fresh engagement data for a single published post from LinkedIn's
// Social Metadata API (2026-03). Per-row, user-initiated only — never bulk.
// ---------------------------------------------------------------------------
router.post('/sync-metrics', blockedInReviewMode, async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId || 'default';
  const { postId } = req.body;

  if (!userId)  return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!postId)  return res.status(400).json({ ok: false, error: 'missing_post_id' });

  try {
    const metrics = await syncPostMetrics(Number(postId), userId, tenantId);
    return res.json({ ok: true, ...metrics });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }
    if (err.message === 'not_connected' || err.message === 'reconnect_required') {
      return res.status(401).json({ ok: false, error: err.message });
    }
    if (err.message === 'post_not_found') {
      return res.status(404).json({ ok: false, error: 'post_not_found' });
    }
    if (err.message === 'no_linkedin_id') {
      return res.status(422).json({ ok: false, error: 'no_linkedin_id' });
    }
    console.error('[linkedin/sync-metrics] error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

'use strict';

const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();
const { db, getSetting } = require('../db');
const { storeTokens, getValidAccessToken, revokeLinkedInToken } = require('../services/linkedinOAuth');
const { publishNow } = require('../services/linkedinPublisher');
const { addScheduledJob, addCommentJob, removeScheduledJob, isSchedulerEnabled } = require('../services/scheduler');
const { syncPostMetrics, RateLimitError } = require('../services/linkedinMetrics');

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
}

function logScheduledEvent({ scheduledPostId, userId, tenantId, eventType, message = null }) {
  void db.prepare(`
      INSERT INTO scheduled_post_events (scheduled_post_id, user_id, tenant_id, event_type, message)
      VALUES (?, ?, ?, ?, ?)
    `).run(scheduledPostId, userId, tenantId, eventType, message)
    .catch((e) => console.warn('[scheduled_post_events] insert failed:', e.message));
}

/**
 * Cancel a pending/processing scheduled row: DB updates + remove Bull job.
 * @returns {Promise<{ ok: true } | { ok: false, error: string, status?: string }>}
 */
async function cancelScheduledPostById(userId, tenantId, scheduledPostId) {
  const row = await db.prepare(
    'SELECT id, status, post_id FROM scheduled_posts WHERE id = ? AND user_id = ? AND tenant_id = ?'
  ).get(scheduledPostId, userId, tenantId);

  if (!row) return { ok: false, error: 'not_found' };
  if (!['pending', 'processing', 'not_sent'].includes(row.status)) {
    return { ok: false, error: 'cannot_cancel', status: row.status };
  }

  await db.prepare(
    `UPDATE scheduled_posts SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(scheduledPostId);

  logScheduledEvent({
    scheduledPostId,
    userId,
    tenantId,
    eventType: 'cancelled',
  });

  if (row.post_id) {
    await db.prepare(`
      UPDATE generated_posts
      SET status = 'draft'
      WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'scheduled'
    `).run(row.post_id, userId, tenantId);
  }

  await removeScheduledJob(Number(scheduledPostId));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// OAuth state store — CSRF protection for the OAuth redirect.
// Uses Redis when available (required for multi-instance); falls back to an
// in-process Map on single-server deployments where Redis is not configured.
// Each entry: { userId, tenantId } keyed by random UUID, TTL = 10 minutes.
// ---------------------------------------------------------------------------
const { redisSet, redisGet, redisDel } = require('../services/redis');
const oauthStates = new Map(); // fallback for when Redis is unavailable

async function setOAuthState(state, data) {
  const stored = await redisSet(`oauth_state:${state}`, data, 600); // 10 min TTL
  if (!stored) {
    // Redis unavailable — fall back to in-memory with auto-expiry
    oauthStates.set(state, data);
    setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000);
  }
}

async function getOAuthState(state) {
  const data = await redisGet(`oauth_state:${state}`);
  if (data !== null) return data;
  return oauthStates.get(state) || null;
}

async function deleteOAuthState(state) {
  await redisDel(`oauth_state:${state}`);
  oauthStates.delete(state);
}

// ---------------------------------------------------------------------------
// GET /api/linkedin/status
// Lightweight check — used by the UI on page load
// ---------------------------------------------------------------------------
router.get('/status', (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;

  if (!userId) return res.json({ ok: true, connected: false, name: null, photo_url: null });

  (async () => {
    const row = await db.prepare(
      'SELECT linkedin_name, linkedin_photo, linkedin_headline FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
    ).get(userId, tenantId);

    return res.json({
      ok:        true,
      connected: !!row,
      name:      row?.linkedin_name || null,
      photo_url: row?.linkedin_photo?.trim() || null,
      headline:  row?.linkedin_headline || null,
    });
  })().catch(() => res.json({ ok: true, connected: false, name: null, photo_url: null }));
});

// ---------------------------------------------------------------------------
// GET /api/linkedin/connect
// Initiates OAuth flow — redirects to LinkedIn authorization page
// ---------------------------------------------------------------------------
router.get('/connect', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;

  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated' });

  const clientId    = (process.env.LINKEDIN_CLIENT_ID || '').trim();
  const redirectUri = (process.env.LINKEDIN_REDIRECT_URI || '').trim();

  if (!clientId || !redirectUri) {
    return res.status(500).json({ ok: false, error: 'linkedin_not_configured' });
  }

  const state = crypto.randomUUID();
  // Allow callers to signal where to return after OAuth completes.
  // 'onboarding' is the only recognised source; everything else falls back to
  // the account page.  Stored inside the signed state blob so it cannot be
  // tampered with by the client.
  const from = req.query.from;
  const returnTo = from === 'onboarding'
    ? '/onboarding.html?linkedin=connected'
    : from === 'generate'
    ? '/generate.html?linkedin=connected'
    : from === 'preview'
    ? '/preview.html?linkedin=connected'
    : '/account.html?linkedin_connected=true';
  await setOAuthState(state, { userId, tenantId, returnTo });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  redirectUri,
    state,
    scope:         'openid profile w_member_social',
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
    return res.redirect(`/account.html?linkedin_error=${encodeURIComponent(oauthError)}`);
  }

  const stateData = state ? await getOAuthState(state) : null;
  if (!stateData) {
    return res.redirect('/account.html?linkedin_error=invalid_state');
  }
  await deleteOAuthState(state);

  const { userId, tenantId } = stateData;

  try {
    const clientId     = (process.env.LINKEDIN_CLIENT_ID || '').trim();
    const clientSecret = (process.env.LINKEDIN_CLIENT_SECRET || '').trim();
    const redirectUri  = (process.env.LINKEDIN_REDIRECT_URI || '').trim();

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
      return res.redirect('/account.html?linkedin_error=token_exchange_failed');
    }

    const tokens = await tokenRes.json();

    // Fetch LinkedIn profile via OpenID Connect userinfo endpoint
    const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` },
    });

    let linkedin_user_id = null;
    let linkedin_name    = null;
    let linkedin_photo   = null;
    let linkedin_headline = null;

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

    // Always fetch /v2/me for headline; also used as fallback for name and photo.
    try {
      const meRes = await fetch(
        'https://api.linkedin.com/v2/me?projection=(localizedFirstName,localizedLastName,localizedHeadline,profilePicture(displayImage~:playableStreams))',
        {
          headers: {
            'Authorization': `Bearer ${tokens.access_token}`,
            'LinkedIn-Version': '202308',
          },
        }
      );

      if (meRes.ok) {
        const me = await meRes.json();
        if (!linkedin_name) {
          linkedin_name = `${me.localizedFirstName || ''} ${me.localizedLastName || ''}`.trim() || null;
        }
        if (me.localizedHeadline) linkedin_headline = me.localizedHeadline;

        if (!linkedin_photo) {
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
        }
      } else {
        const text = await meRes.text();
        console.warn('[linkedin/callback] me fetch failed:', meRes.status, text);
      }
    } catch (e) {
      console.warn('[linkedin/callback] me fetch error:', e.message);
    }

    await storeTokens(userId, tenantId, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      expires_in: tokens.expires_in,
      linkedin_user_id,
      linkedin_name,
      linkedin_photo,
      linkedin_headline,
    });

    console.log(`[linkedin/callback] Connected user=${userId} as ${linkedin_name} (${linkedin_user_id})`);
    res.redirect(stateData.returnTo || '/account.html?linkedin_connected=true');

  } catch (err) {
    console.error('[linkedin/callback] Error:', err.message);
    res.redirect(`/account.html?linkedin_error=${encodeURIComponent(err.message)}`);
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
  const { content, image_url, carousel_pdf_url, postId } = req.body;

  if (!userId)  return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!content?.trim()) return res.status(400).json({ ok: false, error: 'missing_content' });
  if (content.length > 3000) return res.status(400).json({ ok: false, error: 'content_too_long' });
  if (image_url && typeof image_url !== 'string') return res.status(400).json({ ok: false, error: 'invalid_image_url' });
  if (carousel_pdf_url && typeof carousel_pdf_url !== 'string') {
    return res.status(400).json({ ok: false, error: 'invalid_carousel_pdf_url' });
  }

  if (postId) {
    const gp = await db.prepare(
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
      await db.prepare(`
        UPDATE generated_posts
        SET status = 'published', published_at = CURRENT_TIMESTAMP, asset_type = ?
        WHERE id = ? AND user_id = ? AND tenant_id = ?
      `).run(assetType, postId, userId, tenantId);

      if (result.linkedin_post_id) {
        await db.prepare(`UPDATE generated_posts SET linkedin_post_id = ? WHERE id = ? AND user_id = ? AND tenant_id = ?`)
          .run(result.linkedin_post_id, postId, userId, tenantId);
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
router.post('/schedule', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  const { content, scheduled_for, post_id, image_url, carousel_pdf_url, first_comment } = req.body;

  if (!userId)         return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!content?.trim()) return res.status(400).json({ ok: false, error: 'missing_content' });
  if (content.length > 3000) return res.status(400).json({ ok: false, error: 'content_too_long' });
  if (!scheduled_for)  return res.status(400).json({ ok: false, error: 'missing_scheduled_for' });
  if (image_url && typeof image_url !== 'string') return res.status(400).json({ ok: false, error: 'invalid_image_url' });
  if (carousel_pdf_url && typeof carousel_pdf_url !== 'string') {
    return res.status(400).json({ ok: false, error: 'invalid_carousel_pdf_url' });
  }
  if (image_url && carousel_pdf_url) {
    return res.status(400).json({ ok: false, error: 'multiple_assets_not_supported' });
  }
  const trimmedFirstComment = first_comment?.trim() || null;
  if (trimmedFirstComment && trimmedFirstComment.length > 1250) {
    return res.status(400).json({ ok: false, error: 'first_comment_too_long' });
  }

  // Global kill-switch
  const schedulingEnabled = String((await getSetting('scheduling_enabled')) ?? '1').trim();
  if (schedulingEnabled === '0' || schedulingEnabled.toLowerCase() === 'false') {
    return res.status(503).json({ ok: false, error: 'scheduling_disabled' });
  }

  // Don't allow "fake scheduled" rows when the scheduler isn't running.
  // Scheduling relies on BullMQ + Redis; without it, posts won't auto-publish.
  if (!isSchedulerEnabled()) {
    return res.status(503).json({ ok: false, error: 'scheduling_unavailable' });
  }

  const scheduledDate = new Date(scheduled_for);
  if (isNaN(scheduledDate)) {
    return res.status(400).json({ ok: false, error: 'scheduled_for_invalid' });
  }

  // Guardrails: must be at least 5 minutes in the future, and not more than 30 days out.
  const now = Date.now();
  const minLeadMs = 5 * 60 * 1000;
  const maxHorizonMs = 30 * 24 * 60 * 60 * 1000;
  const when = scheduledDate.getTime();
  if (when <= now + minLeadMs) {
    return res.status(400).json({ ok: false, error: 'scheduled_for_too_soon' });
  }
  if (when > now + maxHorizonMs) {
    return res.status(400).json({ ok: false, error: 'scheduled_for_too_far' });
  }

  // Verify user is connected
  const tokenRow = await db.prepare(
    'SELECT id FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
  ).get(userId, tenantId);
  if (!tokenRow) return res.status(401).json({ ok: false, error: 'not_connected' });

  // Guardrails: cap pending scheduled posts per user
  const { cnt } = await db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM scheduled_posts
    WHERE user_id = ? AND tenant_id = ? AND status IN ('pending', 'processing')
  `).get(userId, tenantId);
  // Cap total pending posts per user (2 posts/day × up to 5 days ahead).
  if ((cnt ?? 0) >= 10) {
    return res.status(429).json({ ok: false, error: 'too_many_scheduled' });
  }

  // Guardrails: cap scheduled sends per day (based on scheduled_for date)
  const { daily } = await db.prepare(`
    SELECT COUNT(*) AS daily
    FROM scheduled_posts
    WHERE user_id = ? AND tenant_id = ?
      AND date(scheduled_for) = date(?)
      AND status IN ('pending', 'processing', 'published')
  `).get(userId, tenantId, scheduledDate.toISOString());
  if ((daily ?? 0) >= 2) {
    return res.status(429).json({ ok: false, error: 'daily_schedule_limit' });
  }

  // Guardrails: enforce a minimum spacing between scheduled posts per user
  // (aligned with LinkedIn rate limits and 2-posts-per-day policy)
  const MIN_GAP_MINUTES = 240; // 4 hours
  // Cross-DB: avoid SQLite-only strftime/extract functions; compute spacing in JS.
  const activeTimes = await db.prepare(`
    SELECT scheduled_for
    FROM scheduled_posts
    WHERE user_id = ? AND tenant_id = ?
      AND status IN ('pending', 'processing')
    ORDER BY scheduled_for ASC
  `).all(userId, tenantId);
  let nearest = null;
  for (const r of activeTimes || []) {
    const t = new Date(r.scheduled_for).getTime();
    if (!Number.isFinite(t)) continue;
    const delta = Math.abs(t - scheduledDate.getTime());
    if (!nearest || delta < nearest.delta) nearest = { when: r.scheduled_for, delta };
  }

  if (nearest?.when) {
    if (nearest.delta < MIN_GAP_MINUTES * 60 * 1000) {
      return res.status(400).json({ ok: false, error: 'scheduled_too_close' });
    }
  }

  try {
    const payloadHash = sha256Hex(JSON.stringify({
      content: content.trim(),
      asset_type: carousel_pdf_url ? 'carousel' : image_url ? 'image' : null,
      asset_url: (carousel_pdf_url || image_url)?.trim() || null,
      scheduled_for: scheduledDate.toISOString(),
      first_comment: trimmedFirstComment,
    }));

    // Atomically insert the scheduled_posts row and update generated_posts status.
    // If either DB write fails the transaction rolls back — no orphaned rows.
    let scheduledPostId;
    await db.transaction(async tx => {
      const result = await tx.prepare(`
        INSERT INTO scheduled_posts (user_id, tenant_id, post_id, content, scheduled_for, status, asset_type, asset_url, payload_hash, first_comment, first_comment_status)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
        RETURNING id
      `).run(
        userId,
        tenantId,
        post_id || null,
        content.trim(),
        scheduledDate.toISOString(),
        carousel_pdf_url ? 'carousel' : image_url ? 'image' : null,
        (carousel_pdf_url || image_url)?.trim() || null,
        payloadHash,
        trimmedFirstComment,
        trimmedFirstComment ? 'pending' : null
      );
      scheduledPostId = Number(result.lastInsertRowid);

      if (post_id) {
        await tx.prepare(`
          UPDATE generated_posts
          SET status = 'scheduled'
          WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'draft'
        `).run(post_id, userId, tenantId);
      }
    });

    logScheduledEvent({
      scheduledPostId,
      userId,
      tenantId,
      eventType: 'created',
      message: `scheduled_for=${scheduledDate.toISOString()}`,
    });

    try {
      const bullJobId = await addScheduledJob(scheduledPostId, scheduledDate);
      await db.prepare(`
        UPDATE scheduled_posts
        SET bull_job_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ? AND tenant_id = ?
      `).run(String(bullJobId), scheduledPostId, userId, tenantId);

      logScheduledEvent({
        scheduledPostId,
        userId,
        tenantId,
        eventType: 'enqueued',
        message: `bull_job_id=${bullJobId}`,
      });
    } catch (e) {
      // BullMQ enqueue failed — roll back the DB row so there's no orphan.
      await db.transaction(async tx => {
        await tx.prepare('DELETE FROM scheduled_post_events WHERE scheduled_post_id = ?')
          .run(scheduledPostId);
        await tx.prepare('DELETE FROM scheduled_posts WHERE id = ? AND user_id = ? AND tenant_id = ?')
          .run(scheduledPostId, userId, tenantId);
        if (post_id) {
          await tx.prepare(`
            UPDATE generated_posts
            SET status = 'draft'
            WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'scheduled'
          `).run(post_id, userId, tenantId);
        }
      });
      throw e;
    }

    return res.json({ ok: true, scheduled_post_id: scheduledPostId });
  } catch (err) {
    console.error('[linkedin/schedule] Error:', err.message);
    if (err.message?.includes('scheduler_not_initialized')) {
      return res.status(503).json({ ok: false, error: 'scheduling_unavailable' });
    }
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

  (async () => {
    const posts = await db.prepare(`
      SELECT sp.id, sp.content, sp.scheduled_for, sp.status,
             sp.linkedin_post_id, sp.error_message, sp.attempts, sp.created_at,
             sp.post_id, gp.format_slug, gp.funnel_type
      FROM   scheduled_posts sp
      LEFT JOIN generated_posts gp ON sp.post_id = gp.id
      WHERE  sp.user_id = ? AND sp.tenant_id = ? AND sp.status IN ('pending', 'processing', 'not_sent')
      ORDER  BY sp.scheduled_for ASC
    `).all(userId, tenantId);

    return res.json({ ok: true, posts });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
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

  const result = await cancelScheduledPostById(userId, tenantId, Number(id));
  if (!result.ok) {
    if (result.error === 'not_found') return res.status(404).json({ ok: false, error: 'not_found' });
    return res.status(400).json({ ok: false, error: result.error, status: result.status });
  }

  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/linkedin/scheduled/:id/dismiss
// Dismiss a not_sent (failed) post — marks it cancelled so it leaves the feed.
// ---------------------------------------------------------------------------
router.delete('/scheduled/:id/dismiss', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  const id       = Number(req.params.id);

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });

  const row = await db.prepare(
    'SELECT id, status, post_id FROM scheduled_posts WHERE id = ? AND user_id = ? AND tenant_id = ?'
  ).get(id, userId, tenantId);

  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  if (row.status !== 'not_sent') {
    return res.status(400).json({ ok: false, error: 'cannot_dismiss', status: row.status });
  }

  await db.prepare(
    `UPDATE scheduled_posts SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(id);

  if (row.post_id) {
    await db.prepare(`
      UPDATE generated_posts SET status = 'draft'
      WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'scheduled'
    `).run(row.post_id, userId, tenantId);
  }

  logScheduledEvent({ scheduledPostId: id, userId, tenantId, eventType: 'cancelled', message: 'dismissed_by_user' });

  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/linkedin/scheduled/:id/reschedule
// Reschedule a not_sent post. Creates a new scheduled_posts row (same content/
// assets) and marks the old row cancelled.
// Body: { scheduled_for: ISO datetime string | null }
//   null / omitted → publish now (~10 s delay)
// ---------------------------------------------------------------------------
router.post('/scheduled/:id/reschedule', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  const id       = Number(req.params.id);
  const { scheduled_for } = req.body || {};

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });

  const schedulingEnabled = String((await getSetting('scheduling_enabled')) ?? '1').trim();
  if (schedulingEnabled === '0' || schedulingEnabled.toLowerCase() === 'false') {
    return res.status(503).json({ ok: false, error: 'scheduling_disabled' });
  }
  if (!isSchedulerEnabled()) {
    return res.status(503).json({ ok: false, error: 'scheduling_unavailable' });
  }

  const old = await db.prepare(
    'SELECT * FROM scheduled_posts WHERE id = ? AND user_id = ? AND tenant_id = ?'
  ).get(id, userId, tenantId);

  if (!old) return res.status(404).json({ ok: false, error: 'not_found' });
  if (old.status !== 'not_sent') {
    return res.status(400).json({ ok: false, error: 'not_reschedulable', status: old.status });
  }

  const publishNowMode = !scheduled_for;
  let scheduledDate;
  if (publishNowMode) {
    scheduledDate = new Date(Date.now() + 10_000); // fire ~10 s from now
  } else {
    scheduledDate = new Date(scheduled_for);
    if (isNaN(scheduledDate)) {
      return res.status(400).json({ ok: false, error: 'scheduled_for_invalid' });
    }
    const now = Date.now();
    if (scheduledDate.getTime() <= now + 5 * 60 * 1000) {
      return res.status(400).json({ ok: false, error: 'scheduled_for_too_soon' });
    }
    if (scheduledDate.getTime() > now + 30 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ ok: false, error: 'scheduled_for_too_far' });
    }
  }

  const oldFirstComment = old.first_comment || null;
  const payloadHash = sha256Hex(JSON.stringify({
    content: old.content,
    asset_type: old.asset_type || null,
    asset_url: old.asset_url || null,
    scheduled_for: scheduledDate.toISOString(),
    first_comment: oldFirstComment,
  }));

  let newScheduledPostId;
  try {
    await db.transaction(async tx => {
      await tx.prepare(
        `UPDATE scheduled_posts SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(id);

      const result = await tx.prepare(`
        INSERT INTO scheduled_posts
          (user_id, tenant_id, post_id, content, scheduled_for, status, asset_type, asset_url, payload_hash, first_comment, first_comment_status)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
        RETURNING id
      `).run(
        userId, tenantId,
        old.post_id || null,
        old.content,
        scheduledDate.toISOString(),
        old.asset_type || null,
        old.asset_url || null,
        payloadHash,
        oldFirstComment,
        oldFirstComment ? 'pending' : null
      );
      newScheduledPostId = Number(result.lastInsertRowid);
    });

    logScheduledEvent({ scheduledPostId: id, userId, tenantId, eventType: 'cancelled', message: `rescheduled_as=${newScheduledPostId}` });
    logScheduledEvent({ scheduledPostId: newScheduledPostId, userId, tenantId, eventType: 'created', message: `rescheduled_from=${id},scheduled_for=${scheduledDate.toISOString()}` });

    const bullJobId = await addScheduledJob(newScheduledPostId, scheduledDate);
    await db.prepare(
      `UPDATE scheduled_posts SET bull_job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(String(bullJobId), newScheduledPostId);

    logScheduledEvent({ scheduledPostId: newScheduledPostId, userId, tenantId, eventType: 'enqueued', message: `bull_job_id=${bullJobId}` });

    return res.json({ ok: true, scheduled_post_id: newScheduledPostId, publish_now: publishNowMode });
  } catch (err) {
    console.error('[linkedin/reschedule] Error:', err.message);
    if (err.message?.includes('scheduler_not_initialized')) {
      return res.status(503).json({ ok: false, error: 'scheduling_unavailable' });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/linkedin/suggest-first-comment
// Generate an AI-suggested first comment for a LinkedIn post.
// Body: { content } — the post body text
// Returns: { suggestion: string }
// ---------------------------------------------------------------------------
router.post('/suggest-first-comment', async (req, res) => {
  const userId = req.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const { content } = req.body || {};
  if (!content?.trim()) return res.status(400).json({ ok: false, error: 'missing_content' });

  const Anthropic = require('@anthropic-ai/sdk');
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) return res.status(500).json({ ok: false, error: 'no_api_key' });

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: 'You are a LinkedIn growth expert. Generate a concise, high-converting first comment for a LinkedIn post. The comment should add value — a CTA, a key takeaway, a relevant link placeholder, or hashtags. Keep it under 200 characters. No generic phrases like "Great post!" or "Love this!". No emojis unless they genuinely add meaning.',
      messages: [{
        role: 'user',
        content: `Post:\n\n${content.trim().slice(0, 2000)}\n\nGenerate the first comment.`,
      }],
    });
    const suggestion = message.content[0]?.text?.trim() || '';
    return res.json({ ok: true, suggestion });
  } catch (err) {
    console.error('[linkedin/suggest-first-comment] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'generation_failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/linkedin/scheduled/pause-by-post
// Cancel schedule by generated_posts id — used from generate.html (Pause to edit)
// Body: { post_id }
// ---------------------------------------------------------------------------
router.post('/scheduled/pause-by-post', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  const postId   = req.body?.post_id != null ? Number(req.body.post_id) : NaN;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!Number.isFinite(postId)) return res.status(400).json({ ok: false, error: 'invalid_post_id' });

  const schedRow = await db.prepare(`
    SELECT id FROM scheduled_posts
    WHERE post_id = ? AND user_id = ? AND tenant_id = ? AND status IN ('pending', 'processing')
  `).get(postId, userId, tenantId);

  if (!schedRow) {
    const gp = await db.prepare(
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
  const userId   = req.userId;
  const tenantId = req.tenantId;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  // Cancel any pending/processing scheduled posts to avoid publishing after disconnect.
  (async () => {
    const active = await db.prepare(`
      SELECT id, post_id
      FROM scheduled_posts
      WHERE user_id = ? AND tenant_id = ? AND status IN ('pending', 'processing')
    `).all(userId, tenantId);

    for (const row of active) {
      await db.prepare(`
        UPDATE scheduled_posts
        SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(row.id);

      if (row.post_id) {
        await db.prepare(`
          UPDATE generated_posts
          SET status = 'draft'
          WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'scheduled'
        `).run(row.post_id, userId, tenantId);
      }

      // Best-effort job removal (non-fatal if scheduler isn't running)
      removeScheduledJob(Number(row.id)).catch(() => {});

      logScheduledEvent({
        scheduledPostId: row.id,
        userId,
        tenantId,
        eventType: 'cancelled_disconnect',
      });
    }

    // Revoke the token on LinkedIn's auth server before deleting it locally.
    await revokeLinkedInToken(userId, tenantId);

    await db.prepare(
      'DELETE FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
    ).run(userId, tenantId);

    return res.json({ ok: true });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
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

  (async () => {
    // Revoke the LinkedIn token before the transaction deletes the encrypted row we need to read.
    await revokeLinkedInToken(userId, tenantId);

    await db.transaction(async tx => {
      await tx.prepare(`
        DELETE FROM scheduled_post_events
        WHERE scheduled_post_id IN (
          SELECT id FROM scheduled_posts WHERE user_id = ? AND tenant_id = ?
        )
      `).run(userId, tenantId);
      await tx.prepare('DELETE FROM scheduled_posts WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
      await tx.prepare('DELETE FROM copy_events WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
      await tx.prepare('DELETE FROM generated_posts WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
      await tx.prepare('DELETE FROM generation_runs WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
      await tx.prepare('DELETE FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
      await tx.prepare('DELETE FROM user_profiles WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
      await tx.prepare('DELETE FROM tenant_settings WHERE tenant_id = ?').run(tenantId);
    });

    console.log(`[linkedin/user-data] All data deleted for user=${userId} tenant=${tenantId}`);
    return res.json({ ok: true });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// POST /api/linkedin/sync-metrics
// Fetches fresh engagement data for a single published post from LinkedIn's
// Social Metadata API (2026-03). Per-row, user-initiated only — never bulk.
// ---------------------------------------------------------------------------
router.post('/sync-metrics', async (req, res) => {
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

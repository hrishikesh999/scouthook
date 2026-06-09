'use strict';

const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();
const { db, getSetting } = require('../db');
const { encrypt, decrypt } = require('../services/linkedinOAuth');
const { publishNow } = require('../services/linkedinPublisher');
const { addScheduledJob, addCommentJob, removeScheduledJob, isSchedulerEnabled } = require('../services/scheduler');
const { syncPostMetrics, RateLimitError } = require('../services/linkedinMetrics');
const { getUserPlan } = require('../services/subscription');
const { planHasFeature } = require('../lib/planFeatures');
const { extractVoiceDNAFromLinkedIn } = require('../services/voiceExtraction');

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
}

// Fire-and-forget: increment archetype publish count on the profile that generated the post.
async function incrementArchetypePreference(profileId, archetype) {
  if (!archetype || !profileId) return;
  try {
    const row = await db.prepare(
      'SELECT user_archetype_preference FROM profiles WHERE id = ?'
    ).get(profileId);
    const prefs = (() => {
      try { return row?.user_archetype_preference ? JSON.parse(row.user_archetype_preference) : {}; }
      catch { return {}; }
    })();
    prefs[archetype] = (prefs[archetype] || 0) + 1;
    await db.prepare(
      'UPDATE profiles SET user_archetype_preference = ? WHERE id = ?'
    ).run(JSON.stringify(prefs), profileId);
  } catch (e) {
    console.warn('[linkedin] incrementArchetypePreference failed (non-fatal):', e.message);
  }
}

function logScheduledEvent({ scheduledPostId, userId, tenantId, eventType, message = null }) {
  void db.prepare(`
      INSERT INTO scheduled_post_events (scheduled_post_id, user_id, tenant_id, event_type, message)
      VALUES (?, ?, ?, ?, ?)
    `).run(scheduledPostId, userId, tenantId, eventType, message)
    .catch((e) => console.warn('[scheduled_post_events] insert failed:', e.message));
}

/**
 * Revoke a LinkedIn access token. Best-effort — never throws.
 */
async function revokeToken(accessTokenEnc) {
  const clientId     = (process.env.LINKEDIN_CLIENT_ID || '').trim();
  const clientSecret = (process.env.LINKEDIN_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return;
  try {
    const accessToken = decrypt(accessTokenEnc);
    const params = new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      token:         accessToken,
    });
    const res = await fetch('https://www.linkedin.com/oauth/v2/revoke', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(`[linkedin] Token revocation returned ${res.status}: ${text}`);
    }
  } catch (e) {
    console.warn('[linkedin] Token revocation failed (non-fatal):', e.message);
  }
}

/**
 * Discover LinkedIn organization pages where the authenticated user is an admin,
 * and upsert them as company connections on the workspace's brand profile.
 * Fire-and-forget — errors are swallowed.
 */
async function discoverOrgPages(accessToken, userId, workspaceId, brandProfileId, expiresAt) {
  try {
    const aclRes = await fetch(
      'https://api.linkedin.com/v2/organizationalEntityAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED',
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'LinkedIn-Version': '202308',
          'X-Restli-Protocol-Version': '2.0.0',
        },
      }
    );
    if (!aclRes.ok) {
      console.warn('[linkedin/discoverOrgPages] ACL fetch failed:', aclRes.status, await aclRes.text());
      return;
    }
    const aclData = await aclRes.json();
    const orgIds = (aclData.elements || [])
      .map(el => {
        const urn = el.organizationalTarget;
        const match = typeof urn === 'string' && urn.match(/urn:li:organization:(\d+)/);
        return match ? match[1] : null;
      })
      .filter(Boolean);

    if (orgIds.length === 0) return;

    const accessTokenEnc = encrypt(accessToken);

    for (const orgId of orgIds) {
      let orgName = `Company ${orgId}`;
      let orgLogo = null;
      try {
        const orgRes = await fetch(
          `https://api.linkedin.com/v2/organizations/${orgId}?projection=(id,localizedName,logoV2(original~:playableStreams))`,
          {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'LinkedIn-Version': '202308',
            },
          }
        );
        if (orgRes.ok) {
          const org = await orgRes.json();
          orgName = org.localizedName || orgName;
          const streams = org?.logoV2?.['original~']?.elements || [];
          const best = streams
            .map(el => ({
              url: el?.identifiers?.[0]?.identifier || null,
              area: (el?.data?.['com.linkedin.digitalmedia.mediaartifact.StillImage']?.storageSize?.width || 0) *
                (el?.data?.['com.linkedin.digitalmedia.mediaartifact.StillImage']?.storageSize?.height || 0),
            }))
            .filter(x => !!x.url)
            .sort((a, b) => b.area - a.area)[0];
          if (best?.url) orgLogo = best.url;
        }
      } catch (e) {
        console.warn(`[linkedin/discoverOrgPages] org ${orgId} details fetch failed:`, e.message);
      }

      const accountKey = 'org_' + orgId;
      await db.prepare(`
        INSERT INTO linkedin_connections
          (workspace_id, profile_id, authorized_by, account_type, account_key,
           display_name, avatar_url, organization_id, access_token_enc, expires_at, is_default)
        VALUES (?, ?, ?, 'company', ?, ?, ?, ?, ?, ?, false)
        ON CONFLICT (workspace_id, account_key) DO UPDATE SET
          display_name     = EXCLUDED.display_name,
          avatar_url       = COALESCE(EXCLUDED.avatar_url, linkedin_connections.avatar_url),
          access_token_enc = EXCLUDED.access_token_enc,
          expires_at       = EXCLUDED.expires_at,
          updated_at       = now()
      `).run(workspaceId, brandProfileId, userId, accountKey, orgName, orgLogo, orgId, accessTokenEnc, expiresAt);
    }
    console.log(`[linkedin/discoverOrgPages] Upserted ${orgIds.length} org pages for workspace=${workspaceId}`);
  } catch (e) {
    console.warn('[linkedin/discoverOrgPages] Error (non-fatal):', e.message);
  }
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

  // Trap 16: include tenant_id guard on every bare scheduled_posts UPDATE
  await db.prepare(
    `UPDATE scheduled_posts SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?`
  ).run(scheduledPostId, tenantId);

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
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Redis unavailable — cannot store OAuth CSRF state in production');
    }
    // Dev only: fall back to in-memory with auto-expiry
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
  const tenantId = req.tenantId;

  if (!tenantId) return res.json({ ok: true, connected: false, name: null, photo_url: null });

  (async () => {
    const row = await db.prepare(`
      SELECT display_name, avatar_url, expires_at
      FROM linkedin_connections
      WHERE workspace_id = ? AND account_type = 'personal' AND is_default = true
    `).get(tenantId);

    let expiresInDays = null;
    if (row?.expires_at) {
      expiresInDays = Math.ceil((new Date(row.expires_at) - Date.now()) / 86400000);
    }

    return res.json({
      ok:              true,
      connected:       !!row,
      name:            row?.display_name || null,
      photo_url:       row?.avatar_url?.trim() || null,
      headline:        null,
      expires_in_days: expiresInDays,
    });
  })().catch(() => res.json({ ok: true, connected: false, name: null, photo_url: null }));
});

// ---------------------------------------------------------------------------
// POST /api/linkedin/extract-profile
// Re-run extractVoiceDNAFromLinkedIn on demand.
// ---------------------------------------------------------------------------
router.post('/extract-profile', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  try {
    // Optional body.profile_id targets a specific person profile.
    // Without it, falls back to the default brand profile (original behaviour).
    let targetProfile;
    if (req.body?.profile_id) {
      const pid = Number(req.body.profile_id);
      if (!Number.isFinite(pid)) return res.status(400).json({ ok: false, error: 'invalid_profile_id' });
      targetProfile = await db.prepare(
        'SELECT id FROM profiles WHERE id = ? AND workspace_id = ?'
      ).get(pid, tenantId);
    } else {
      targetProfile = await db.prepare(
        'SELECT id FROM profiles WHERE workspace_id = ? AND is_default = true'
      ).get(tenantId);
    }

    if (!targetProfile) return res.status(404).json({ ok: false, error: 'profile_not_found' });

    const result = await extractVoiceDNAFromLinkedIn(targetProfile.id);
    const profile = await db.prepare(
      `SELECT content_niche, audience_role, business_positioning, content_pillars,
              voice_profile_completion_pct
       FROM profiles WHERE id = ?`
    ).get(targetProfile.id);
    return res.json({ ok: true, updated: result.updated || [], profile: profile || {} });
  } catch (err) {
    console.error('[linkedin/extract-profile] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
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

  // Multiple LinkedIn accounts require Pro plan.
  // Check before starting OAuth so the user sees the error immediately.
  const connectPlan = await getUserPlan(userId);
  if (!planHasFeature(connectPlan, 'multiple_linkedin_accounts')) {
    const existingPersonal = await db.prepare(
      "SELECT id FROM linkedin_connections WHERE workspace_id = ? AND account_type = 'personal' LIMIT 1"
    ).get(tenantId);
    if (existingPersonal) {
      const from2 = req.query.from;
      const errorBase = from2 === 'settings' ? '/settings.html' : '/account.html';
      return res.redirect(`${errorBase}?error=upgrade_required&feature=multiple_linkedin_accounts`);
    }
  }

  const state = crypto.randomUUID();
  const from = req.query.from;
  const returnTo = from === 'onboarding'
    ? '/onboarding.html?linkedin=connected'
    : from === 'generate'
    ? '/generate.html?linkedin=connected'
    : from === 'preview'
    ? '/editor.html?linkedin=connected'
    : from === 'settings'
    ? '/settings.html?linkedin_connected=true#voice-stage-6'
    : '/linkedin.html?linkedin_connected=true';
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
// OAuth callback — exchanges code for tokens, creates profile + connection rows
// ---------------------------------------------------------------------------
router.get('/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  const stateData = state ? await getOAuthState(state) : null;
  const errBase = stateData?.returnTo?.split('?')[0] || '/linkedin.html';

  if (oauthError) {
    if (stateData) await deleteOAuthState(state);
    return res.redirect(`${errBase}?linkedin_error=${encodeURIComponent(oauthError)}`);
  }

  if (!stateData) {
    return res.redirect('/linkedin.html?linkedin_error=invalid_state');
  }
  await deleteOAuthState(state);

  const { userId, tenantId } = stateData;

  if (req.userId && req.userId !== userId) {
    console.warn(`[linkedin/callback] Session user=${req.userId} doesn't match state user=${userId} — rejecting`);
    return res.redirect(`${errBase}?linkedin_error=session_mismatch`);
  }

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
    const expiresAt = new Date(Date.now() + (tokens.expires_in || 5184000) * 1000).toISOString();

    // Fetch LinkedIn profile via OpenID Connect userinfo endpoint
    const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` },
    });

    let linkedin_member_id = null;
    let linkedin_name      = null;
    let linkedin_photo     = null;

    if (profileRes.ok) {
      const profile = await profileRes.json();
      linkedin_member_id = profile.sub;
      linkedin_name      = profile.name || `${profile.given_name || ''} ${profile.family_name || ''}`.trim() || null;
      linkedin_photo     = profile.picture || null;
    } else {
      const text = await profileRes.text();
      console.error('[linkedin/callback] userinfo fetch failed:', profileRes.status, text);
    }

    // Fetch /v2/me for headline (also fallback for name/photo)
    try {
      const meRes = await fetch(
        'https://api.linkedin.com/v2/me?projection=(localizedFirstName,localizedLastName,profilePicture(displayImage~:playableStreams))',
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
        console.warn('[linkedin/callback] me fetch failed:', meRes.status);
      }
    } catch (e) {
      console.warn('[linkedin/callback] me fetch error:', e.message);
    }

    const errBase = stateData?.returnTo?.split('?')[0] || '/account.html';

    // Duplicate-member check: reject if this linkedin_member_id is already claimed
    // by a DIFFERENT workspace member in this workspace.
    if (linkedin_member_id) {
      const claimed = await db.prepare(
        `SELECT authorized_by FROM linkedin_connections WHERE workspace_id = ? AND account_key = ?`
      ).get(tenantId, 'person_' + linkedin_member_id);

      if (claimed && claimed.authorized_by !== userId) {
        console.warn(`[linkedin/callback] Duplicate: linkedin_member_id=${linkedin_member_id} already claimed by user=${claimed.authorized_by}, rejected user=${userId}`);
        return res.redirect(`${errBase}?linkedin_error=linkedin_already_connected`);
      }
    }

    const accessTokenEnc  = encrypt(tokens.access_token);
    const refreshTokenEnc = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;
    const accountKey      = linkedin_member_id ? 'person_' + linkedin_member_id : 'person_unknown_' + crypto.randomUUID();

    // Check if this is a reconnect (connection already exists for this account_key)
    const existingConn = await db.prepare(
      `SELECT id, profile_id FROM linkedin_connections WHERE workspace_id = ? AND account_key = ?`
    ).get(tenantId, accountKey);

    let personProfileId;
    let newProfileId = null; // set only when a brand-new profile is created

    if (existingConn) {
      // Reconnect: update tokens on existing connection
      await db.prepare(`
        UPDATE linkedin_connections
        SET access_token_enc  = ?,
            refresh_token_enc = COALESCE(?, refresh_token_enc),
            expires_at        = ?,
            display_name      = COALESCE(?, display_name),
            avatar_url        = COALESCE(?, avatar_url),
            updated_at        = now()
        WHERE workspace_id = ? AND account_key = ?
      `).run(accessTokenEnc, refreshTokenEnc, expiresAt, linkedin_name, linkedin_photo, tenantId, accountKey);
      personProfileId = existingConn.profile_id;
      console.log(`[linkedin/callback] Reconnected user=${userId} connection=${existingConn.id} (${linkedin_name})`);
    } else {
      // New connection: create a person profile + linkedin_connections row
      const profileResult = await db.prepare(`
        INSERT INTO profiles (workspace_id, profile_type, display_name, avatar_url, is_default)
        VALUES (?, 'person', ?, ?, false)
        RETURNING id
      `).run(tenantId, linkedin_name || 'LinkedIn User', linkedin_photo);
      personProfileId = profileResult.lastInsertRowid;
      newProfileId    = personProfileId;

      // Is this the first personal connection in this workspace? If so, mark as default.
      const existingPersonal = await db.prepare(
        `SELECT id FROM linkedin_connections WHERE workspace_id = ? AND account_type = 'personal' LIMIT 1`
      ).get(tenantId);
      const isDefault = !existingPersonal;

      await db.prepare(`
        INSERT INTO linkedin_connections
          (workspace_id, profile_id, authorized_by, account_type, account_key,
           display_name, avatar_url, linkedin_member_id,
           access_token_enc, refresh_token_enc, expires_at, is_default)
        VALUES (?, ?, ?, 'personal', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tenantId, personProfileId, userId, accountKey,
        linkedin_name, linkedin_photo, linkedin_member_id,
        accessTokenEnc, refreshTokenEnc, expiresAt, isDefault
      );
      console.log(`[linkedin/callback] Connected user=${userId} as ${linkedin_name} (${linkedin_member_id}), profile=${personProfileId}, default=${isDefault}`);
    }

    // Fire-and-forget: discover org pages the user administers
    const brandProfile = await db.prepare(
      'SELECT id FROM profiles WHERE workspace_id = ? AND is_default = true'
    ).get(tenantId);
    if (brandProfile?.id) {
      discoverOrgPages(tokens.access_token, userId, tenantId, brandProfile.id, expiresAt)
        .catch(e => console.warn('[linkedin/callback] discoverOrgPages failed (non-fatal):', e.message));
    }

    // Fire-and-forget: extract voice DNA from LinkedIn activity for the person profile
    extractVoiceDNAFromLinkedIn(personProfileId).catch(e =>
      console.warn('[linkedin/callback] extractVoiceDNAFromLinkedIn failed (non-fatal):', e.message)
    );

    // Append profile_id to returnTo so frontend can open mini-onboarding modal
    let redirectTarget = stateData.returnTo || '/account.html?linkedin_connected=true';
    if (newProfileId) {
      const sep = redirectTarget.includes('?') ? '&' : '?';
      redirectTarget += `${sep}new_profile_id=${newProfileId}`;
    }

    res.redirect(redirectTarget);

  } catch (err) {
    console.error('[linkedin/callback] Error:', err.message);
    const errBase = stateData?.returnTo?.split('?')[0] || '/account.html';
    res.redirect(`${errBase}?linkedin_error=${encodeURIComponent(err.message)}`);
  }
});

// ---------------------------------------------------------------------------
// GET /api/linkedin/connections
// List all LinkedIn connections in the workspace, grouped by profile
// ---------------------------------------------------------------------------
router.get('/connections', async (req, res) => {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ ok: false, error: 'missing_tenant' });

  try {
    const rows = await db.prepare(`
      SELECT
        lc.id, lc.profile_id, lc.account_type, lc.account_key, lc.display_name,
        lc.avatar_url, lc.linkedin_member_id, lc.organization_id,
        lc.expires_at, lc.is_default, lc.authorized_by,
        p.profile_type, p.display_name AS profile_display_name, p.avatar_url AS profile_avatar_url,
        p.content_niche, p.audience_role, p.content_pillars, p.voice_profile_completion_pct
      FROM linkedin_connections lc
      JOIN profiles p ON p.id = lc.profile_id
      WHERE lc.workspace_id = ?
      ORDER BY p.profile_type DESC, lc.account_type ASC, lc.created_at ASC
    `).all(tenantId);

    // Group by profile
    const profileMap = new Map();
    for (const row of rows) {
      if (!profileMap.has(row.profile_id)) {
        profileMap.set(row.profile_id, {
          id:                          row.profile_id,
          profile_type:                row.profile_type,
          display_name:                row.profile_display_name,
          avatar_url:                  row.profile_avatar_url,
          content_niche:               row.content_niche               || null,
          audience_role:               row.audience_role               || null,
          content_pillars:             row.content_pillars             || null,
          voice_profile_completion_pct: row.voice_profile_completion_pct || 0,
          connections:                 [],
        });
      }
      profileMap.get(row.profile_id).connections.push({
        id:                 row.id,
        account_type:       row.account_type,
        account_key:        row.account_key,
        display_name:       row.display_name,
        avatar_url:         row.avatar_url,
        linkedin_member_id: row.linkedin_member_id,
        organization_id:    row.organization_id,
        expires_at:         row.expires_at,
        is_default:         row.is_default,
        authorized_by:      row.authorized_by,
      });
    }

    return res.json({ ok: true, profiles: [...profileMap.values()] });
  } catch (err) {
    console.error('[linkedin/connections] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/linkedin/connections/:id
// Disconnect a LinkedIn connection. Revokes the token only if it is the last
// connection sharing that linkedin_member_id in this workspace.
// ---------------------------------------------------------------------------
router.delete('/connections/:id', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  const id       = Number(req.params.id);

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });

  try {
    const conn = await db.prepare(
      `SELECT id, workspace_id, authorized_by, account_type, account_key,
              linkedin_member_id, access_token_enc, profile_id
       FROM linkedin_connections WHERE id = ? AND workspace_id = ?`
    ).get(id, tenantId);

    if (!conn) return res.status(404).json({ ok: false, error: 'not_found' });

    // Cancel pending scheduled posts that use this workspace (simplified: all pending)
    // Full connection-scoped cancellation is deferred to Sprint 3 Task 2
    // when scheduled_posts.linkedin_connection_id column is added.
    const activePosts = await db.prepare(`
      SELECT id, post_id FROM scheduled_posts
      WHERE tenant_id = ? AND status IN ('pending', 'processing')
    `).all(tenantId);

    for (const row of activePosts) {
      await db.prepare(`
        UPDATE scheduled_posts SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND tenant_id = ?
      `).run(row.id, tenantId);
      if (row.post_id) {
        await db.prepare(`
          UPDATE generated_posts SET status = 'draft'
          WHERE id = ? AND tenant_id = ? AND status = 'scheduled'
        `).run(row.post_id, tenantId);
      }
      removeScheduledJob(Number(row.id)).catch(() => {});
    }

    // Revoke token only if no other connections in this workspace share the same member_id
    if (conn.linkedin_member_id) {
      const sibling = await db.prepare(
        `SELECT id FROM linkedin_connections WHERE workspace_id = ? AND linkedin_member_id = ? AND id != ? LIMIT 1`
      ).get(tenantId, conn.linkedin_member_id, id);
      if (!sibling) {
        await revokeToken(conn.access_token_enc);
      }
    }

    await db.prepare('DELETE FROM linkedin_connections WHERE id = ? AND workspace_id = ?').run(id, tenantId);

    // Clean up the associated person profile if it has no remaining connections
    if (conn.profile_id) {
      const remaining = await db.prepare(
        `SELECT id FROM linkedin_connections WHERE profile_id = ? LIMIT 1`
      ).get(conn.profile_id);
      if (!remaining) {
        await db.prepare('DELETE FROM profiles WHERE id = ? AND workspace_id = ? AND profile_type = ?').run(conn.profile_id, tenantId, 'person');
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[linkedin/connections/delete] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/linkedin/connections/:id/set-default
// Set a connection as the default for its profile
// ---------------------------------------------------------------------------
router.post('/connections/:id/set-default', async (req, res) => {
  const tenantId = req.tenantId;
  const id       = Number(req.params.id);

  if (!req.userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });

  try {
    const conn = await db.prepare(
      `SELECT id, profile_id FROM linkedin_connections WHERE id = ? AND workspace_id = ?`
    ).get(id, tenantId);

    if (!conn) return res.status(404).json({ ok: false, error: 'not_found' });

    await db.transaction(async tx => {
      await tx.prepare(
        `UPDATE linkedin_connections SET is_default = false WHERE profile_id = ?`
      ).run(conn.profile_id);
      await tx.prepare(
        `UPDATE linkedin_connections SET is_default = true WHERE id = ? AND workspace_id = ?`
      ).run(id, tenantId);
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[linkedin/connections/set-default] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
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
      'SELECT status FROM generated_posts WHERE id = ? AND tenant_id = ?'
    ).get(postId, tenantId);
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

    if (postId) {
      const assetType = carousel_pdf_url ? 'carousel' : image_url ? 'image' : null;
      await db.prepare(`
        UPDATE generated_posts
        SET status = 'published', published_at = CURRENT_TIMESTAMP, asset_type = ?
        WHERE id = ? AND tenant_id = ?
      `).run(assetType, postId, tenantId);

      if (result.linkedin_post_id) {
        await db.prepare(`UPDATE generated_posts SET linkedin_post_id = ? WHERE id = ? AND tenant_id = ?`)
          .run(result.linkedin_post_id, postId, tenantId);
      }

      const postRow = await db.prepare('SELECT archetype_used, profile_id FROM generated_posts WHERE id = ? AND tenant_id = ?')
        .get(postId, tenantId);
      if (postRow?.archetype_used && postRow.profile_id) {
        incrementArchetypePreference(postRow.profile_id, postRow.archetype_used).catch(() => {});
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
  const { content, scheduled_for, post_id, image_url, carousel_pdf_url, first_comment, asset_preview_url, asset_slide_count } = req.body;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  // Scheduling requires Pro
  const schedulePlan = await getUserPlan(userId);
  if (!planHasFeature(schedulePlan, 'scheduling')) {
    return res.status(403).json({ ok: false, error: 'feature_not_available', feature: 'scheduling', requiredPlan: 'pro' });
  }

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

  if (!isSchedulerEnabled()) {
    return res.status(503).json({ ok: false, error: 'scheduling_unavailable' });
  }

  const scheduledDate = new Date(scheduled_for);
  if (isNaN(scheduledDate)) {
    return res.status(400).json({ ok: false, error: 'scheduled_for_invalid' });
  }

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

  // Verify workspace has at least one active personal LinkedIn connection
  const connRow = await db.prepare(
    `SELECT id FROM linkedin_connections WHERE workspace_id = ? AND account_type = 'personal' LIMIT 1`
  ).get(tenantId);
  if (!connRow) return res.status(401).json({ ok: false, error: 'not_connected' });

  // Guardrails: cap pending scheduled posts per user
  const { cnt } = await db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM scheduled_posts
    WHERE user_id = ? AND tenant_id = ? AND status IN ('pending', 'processing')
  `).get(userId, tenantId);
  if ((cnt ?? 0) >= 10) {
    return res.status(429).json({ ok: false, error: 'too_many_scheduled' });
  }

  // Guardrails: cap scheduled sends per day
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

  // Guardrails: enforce minimum spacing between scheduled posts
  const MIN_GAP_MINUTES = 240; // 4 hours
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
        const assetType = carousel_pdf_url ? 'carousel' : image_url ? 'image' : null;
        const assetUrl  = (carousel_pdf_url || image_url)?.trim() || null;
        await tx.prepare(`
          UPDATE generated_posts
          SET status = 'scheduled',
              asset_type = COALESCE(?, asset_type),
              asset_url = COALESCE(?, asset_url),
              asset_preview_url = COALESCE(?, asset_preview_url),
              asset_slide_count = COALESCE(?, asset_slide_count)
          WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'draft'
        `).run(assetType, assetUrl, asset_preview_url?.trim() || null, asset_slide_count || null, post_id, userId, tenantId);
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
// Dismiss a not_sent (failed) post.
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

  // Trap 16: tenant_id guard on UPDATE
  await db.prepare(
    `UPDATE scheduled_posts SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?`
  ).run(id, tenantId);

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
// Reschedule a not_sent post.
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
    scheduledDate = new Date(Date.now() + 10_000);
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
      // Trap 16: tenant_id guard on the cancellation UPDATE
      await tx.prepare(
        `UPDATE scheduled_posts SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?`
      ).run(id, tenantId);

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
    // Trap 16: tenant_id guard on bull_job_id UPDATE
    await db.prepare(
      `UPDATE scheduled_posts SET bull_job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?`
    ).run(String(bullJobId), newScheduledPostId, tenantId);

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
      max_tokens: 80,
      system: 'Write the first comment for this LinkedIn post. Choose ONE: (a) a sharp, specific question that invites readers to share a personal experience — or (b) a direct 1-line CTA if the post references something to act on. One sentence, max 120 characters. No preamble, no label, no emojis. Output the comment text only.',
      messages: [{
        role: 'user',
        content: content.trim().slice(0, 2000),
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
      'SELECT id, status FROM generated_posts WHERE id = ? AND tenant_id = ?'
    ).get(postId, tenantId);
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
// Remove all of the current user's personal LinkedIn connections in this workspace
// ---------------------------------------------------------------------------
router.post('/disconnect', (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  (async () => {
    // Cancel any pending/processing scheduled posts in this workspace
    const active = await db.prepare(`
      SELECT id, post_id
      FROM scheduled_posts
      WHERE tenant_id = ? AND status IN ('pending', 'processing')
    `).all(tenantId);

    for (const row of active) {
      // Trap 16: tenant_id guard on UPDATE
      await db.prepare(`
        UPDATE scheduled_posts
        SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND tenant_id = ?
      `).run(row.id, tenantId);

      if (row.post_id) {
        await db.prepare(`
          UPDATE generated_posts
          SET status = 'draft'
          WHERE id = ? AND tenant_id = ? AND status = 'scheduled'
        `).run(row.post_id, tenantId);
      }

      removeScheduledJob(Number(row.id)).catch(() => {});
    }

    // Fetch the user's personal connections in this workspace
    const conns = await db.prepare(`
      SELECT id, linkedin_member_id, access_token_enc
      FROM linkedin_connections
      WHERE workspace_id = ? AND authorized_by = ? AND account_type = 'personal'
    `).all(tenantId, userId);

    // Revoke tokens (deduplicated by linkedin_member_id so we don't revoke twice)
    const revokedMemberIds = new Set();
    for (const conn of conns) {
      if (conn.linkedin_member_id && !revokedMemberIds.has(conn.linkedin_member_id)) {
        await revokeToken(conn.access_token_enc);
        revokedMemberIds.add(conn.linkedin_member_id);
      }
    }

    // Delete the personal connections (cascade removes nothing else — profiles remain)
    await db.prepare(
      `DELETE FROM linkedin_connections WHERE workspace_id = ? AND authorized_by = ? AND account_type = 'personal'`
    ).run(tenantId, userId);

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
    // Revoke LinkedIn tokens before the transaction deletes the rows we need to read
    const conns = await db.prepare(
      `SELECT access_token_enc, linkedin_member_id FROM linkedin_connections WHERE workspace_id = ? AND authorized_by = ?`
    ).all(tenantId, userId);
    const revokedMemberIds = new Set();
    for (const conn of conns) {
      if (conn.linkedin_member_id && !revokedMemberIds.has(conn.linkedin_member_id)) {
        await revokeToken(conn.access_token_enc);
        revokedMemberIds.add(conn.linkedin_member_id);
      }
    }

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
      await tx.prepare('DELETE FROM linkedin_connections WHERE workspace_id = ? AND authorized_by = ?').run(tenantId, userId);
      await tx.prepare('DELETE FROM user_profiles WHERE user_id = ?').run(userId);
    });

    console.log(`[linkedin/user-data] All data deleted for user=${userId} tenant=${tenantId}`);
    return res.json({ ok: true });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// POST /api/linkedin/sync-metrics
// Fetches fresh engagement data for a single published post from LinkedIn's
// Social Metadata API. Per-row, user-initiated only — never bulk.
// ---------------------------------------------------------------------------
router.post('/sync-metrics', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  const { postId } = req.body;

  if (!userId)  return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!postId)  return res.status(400).json({ ok: false, error: 'missing_post_id' });

  try {
    const metrics = await syncPostMetrics(Number(postId), tenantId);
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

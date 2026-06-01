'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { getValidAccessToken } = require('../services/linkedinOAuth');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const LINKEDIN_VERSION = '202603';

function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-password'] || req.body?.admin_password;
  if (!ADMIN_PASSWORD || provided !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

function requireUser(req, res) {
  if (!req.userId) {
    res.status(400).json({ ok: false, error: 'not_logged_in' });
    return false;
  }
  return true;
}

// Recursively find specific fields anywhere in a nested object
function findFields(obj, targets) {
  const found = {};
  JSON.stringify(obj, (key, val) => {
    if (targets.includes(key) && !(key in found)) found[key] = val;
    return val;
  });
  return found;
}

// ---------------------------------------------------------------------------
// GET /api/test/commenter-capture/posts
// List LinkedIn-published posts for the current user
// ---------------------------------------------------------------------------
router.get('/commenter-capture/posts', requireAdmin, async (req, res) => {
  if (!requireUser(req, res)) return;

  try {
    const rows = await db.prepare(`
      SELECT id, linkedin_post_id, content, published_at
      FROM generated_posts
      WHERE user_id = ? AND tenant_id = ? AND linkedin_post_id IS NOT NULL
      ORDER BY published_at DESC NULLS LAST
    `).all(req.userId, req.tenantId);

    const posts = rows.map(row => ({
      id: row.id,
      linkedin_post_id: row.linkedin_post_id,
      label: `${row.published_at ? new Date(row.published_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Unknown date'} — ${(row.content || '').slice(0, 60)}${row.content && row.content.length > 60 ? '…' : ''}`,
    }));

    res.json({ ok: true, posts });
  } catch (err) {
    console.error('[test/commenter-capture] posts error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/test/commenter-capture/fetch
// Call LinkedIn Comments API and return the raw response + summary
// ---------------------------------------------------------------------------
router.post('/commenter-capture/fetch', requireAdmin, express.json(), async (req, res) => {
  if (!requireUser(req, res)) return;

  const { shareUrn } = req.body || {};
  if (!shareUrn) {
    return res.status(400).json({ ok: false, error: 'shareUrn is required' });
  }

  let token;
  try {
    token = await getValidAccessToken(req.userId, req.tenantId);
  } catch (err) {
    const msg = err.message || String(err);
    if (msg === 'not_connected') {
      return res.status(400).json({ ok: false, error: 'LinkedIn not connected. Please connect your LinkedIn account first.' });
    }
    if (msg === 'reconnect_required') {
      return res.status(400).json({ ok: false, error: 'LinkedIn token expired and could not be refreshed. Please reconnect your LinkedIn account.' });
    }
    return res.status(500).json({ ok: false, error: `Token error: ${msg}` });
  }

  // Use actor~ projection to get expanded commenter profile fields
  const url = `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(shareUrn)}/comments?projection=(elements*(actor~(firstName,lastName,localizedFirstName,localizedLastName,headline,localizedHeadline,vanityName,profilePicture),message,created,id,commentUrn))`;

  let linkedinRes;
  try {
    linkedinRes = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'LinkedIn-Version': LINKEDIN_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Network error calling LinkedIn: ${err.message}` });
  }

  let raw;
  try {
    raw = await linkedinRes.json();
  } catch {
    return res.status(500).json({ ok: false, error: `LinkedIn returned non-JSON response (status ${linkedinRes.status})` });
  }

  if (!linkedinRes.ok) {
    return res.json({
      ok: false,
      httpStatus: linkedinRes.status,
      error: `LinkedIn returned HTTP ${linkedinRes.status}`,
      raw,
    });
  }

  // Compute summary by scanning for the five key fields anywhere in the response
  const targets = ['firstName', 'lastName', 'headline', 'localizedHeadline', 'vanityName', 'profilePicture'];
  const found = findFields(raw, targets);

  const nameAvailable = 'firstName' in found || 'lastName' in found;
  const headlineAvailable = 'headline' in found || 'localizedHeadline' in found;
  const profileUrlAvailable = 'vanityName' in found;
  const icpScorable = headlineAvailable || profileUrlAvailable;
  const totalComments = Array.isArray(raw.elements) ? raw.elements.length : null;

  res.json({
    ok: true,
    httpStatus: linkedinRes.status,
    raw,
    foundFields: found,
    summary: {
      nameAvailable,
      headlineAvailable,
      profileUrlAvailable,
      icpScorable,
      totalComments,
    },
  });
});

module.exports = router;

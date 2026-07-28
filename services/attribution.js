'use strict';

/**
 * services/attribution.js — paid-acquisition attribution.
 *
 * Meta ad links carry utm_* tags (see the launch ad copy sheet). Those tags
 * previously reached the landing page and stopped there: nothing was persisted,
 * so a paid signup could never be traced back to the ad that produced it.
 *
 * Flow, mirroring the existing sh_ref affiliate cookie in server.js:
 *
 *   1. capture()  — middleware, runs on every request. If the URL carries utm_*
 *                   or a click id, stash them in the sh_attr cookie (30 days).
 *   2. read()     — pull that cookie back off a later request.
 *   3. attachToUser() — called once, at the moment a user is genuinely created
 *                   (email verification, or first Google sign-in), to stamp the
 *                   attribution onto user_profiles.
 *
 * The cookie is deliberately last-touch: if someone clicks ad 1, leaves, then
 * clicks ad 3 and signs up, ad 3 gets the credit. That matches how Meta's own
 * reporting attributes the conversion, so our numbers and theirs agree.
 */

const cookie = require('cookie');
const { db } = require('../db');

const COOKIE_NAME = 'sh_attr';
const MAX_AGE_MS  = 30 * 24 * 60 * 60 * 1000;

// Kept short so the cookie stays far below the 4KB browser limit even when
// every field is populated with a long campaign name.
const MAX_VALUE_LEN = 200;

const FIELDS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'click_id',
  'landing_page',
];

function clean(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_VALUE_LEN);
}

/**
 * Express middleware. Writes the sh_attr cookie whenever a request arrives
 * carrying campaign tags. Mount it before express.static so it also fires for
 * plain HTML landing pages like /sign-up-a.html.
 */
function capture(req, res, next) {
  try {
    const q = req.query || {};

    const attr = {
      utm_source:   clean(q.utm_source),
      utm_medium:   clean(q.utm_medium),
      utm_campaign: clean(q.utm_campaign),
      utm_content:  clean(q.utm_content),
      utm_term:     clean(q.utm_term),
      // fbclid (Meta) and gclid (Google) both land here — whichever is present.
      click_id:     clean(q.fbclid) || clean(q.gclid),
      landing_page: clean(req.path),
    };

    // landing_page alone is not a campaign — only persist when a real tag is
    // present, otherwise every organic pageview would overwrite a live cookie.
    const hasCampaign = FIELDS
      .filter(f => f !== 'landing_page')
      .some(f => attr[f]);

    if (hasCampaign) {
      const encoded = Buffer.from(JSON.stringify(attr), 'utf8').toString('base64');
      res.cookie(COOKIE_NAME, encoded, {
        maxAge:   MAX_AGE_MS,
        httpOnly: true,
        sameSite: 'lax',
      });
    }
  } catch { /* attribution must never break a page load */ }

  return next();
}

/**
 * Read the attribution cookie off a request. Returns null when absent or
 * unparseable (a hand-edited or truncated cookie must not throw).
 */
function read(req) {
  try {
    const cookies = cookie.parse(req.headers?.cookie || '');
    const raw = cookies[COOKIE_NAME];
    if (!raw) return null;

    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;

    const attr = {};
    for (const field of FIELDS) attr[field] = clean(parsed[field]);
    return attr;
  } catch {
    return null;
  }
}

/**
 * Stamp attribution onto a newly created user. Safe to call unconditionally:
 * no-ops when there is nothing to attribute, and never overwrites a row that
 * already carries attribution (first signup wins — a user is only created once,
 * but the guard keeps a retry or a re-linked identity from rewriting history).
 */
async function attachToUser(userId, attr) {
  if (!userId || !attr) return;
  if (!attr.utm_source && !attr.utm_campaign && !attr.click_id) return;

  try {
    await db.prepare(`
      UPDATE user_profiles
      SET    utm_source   = ?,
             utm_medium   = ?,
             utm_campaign = ?,
             utm_content  = ?,
             utm_term     = ?,
             click_id     = ?,
             landing_page = ?
      WHERE  user_id      = ?
        AND  utm_campaign IS NULL
        AND  utm_source   IS NULL
        AND  click_id     IS NULL
    `).run(
      attr.utm_source,
      attr.utm_medium,
      attr.utm_campaign,
      attr.utm_content,
      attr.utm_term,
      attr.click_id,
      attr.landing_page,
      userId,
    );
  } catch (err) {
    // Migration 079 may not have run yet on this environment — never block signup.
    console.error('[attribution] attachToUser failed:', err.message);
  }
}

/** Convenience: read from the request and stamp in one call. */
async function attachFromRequest(userId, req) {
  return attachToUser(userId, read(req));
}

module.exports = {
  COOKIE_NAME,
  capture,
  read,
  attachToUser,
  attachFromRequest,
};

'use strict';

/**
 * routes/emailPreferences.js — idea-email cadence + timezone (Phase 2, task 14).
 *
 * User-scoped (no workspace context needed — email prefs follow the person):
 *   GET /api/email-preferences  → { cadence, timezone }
 *   PUT /api/email-preferences  { cadence?, timezone? }
 *
 * cadence: 'daily' | '3x' | 'weekly' | 'off'. Stored NULL until the user
 * first saves — the email cron resolves NULL via effectiveCadence(): 'daily'
 * while trialing (habit-formation window), 'weekly' after. GET mirrors that
 * resolution so the settings dropdown shows what the cron actually does.
 * timezone: IANA name, validated by probing Intl; invalid input is rejected
 * rather than silently stored (the cron would just fall back, but a saved-
 * then-ignored setting is worse than an error).
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { effectiveCadence } = require('../services/ideaEmails');

const CADENCES = ['daily', '3x', 'weekly', 'off'];

function requireUser(req, res) {
  if (!req.userId) {
    res.status(401).json({ ok: false, error: 'not_authenticated' });
    return false;
  }
  return true;
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

router.get('/', async (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const [row, sub] = await Promise.all([
      db.prepare(
        'SELECT idea_email_cadence, idea_email_timezone FROM user_profiles WHERE user_id = ?'
      ).get(req.userId),
      db.prepare(
        'SELECT status, trial_ends_at FROM user_subscriptions WHERE user_id = ?'
      ).get(req.userId),
    ]);
    // Same trial-validity rule as the cron's candidate query
    const trialing = !!sub && sub.status === 'trialing' &&
      (!sub.trial_ends_at || new Date(sub.trial_ends_at) > new Date());
    return res.json({
      ok: true,
      cadence: effectiveCadence(row?.idea_email_cadence, trialing),
      cadence_is_default: !row?.idea_email_cadence,
      timezone: row?.idea_email_timezone || null,
    });
  } catch (err) {
    console.error('[email-prefs] GET error:', err.message);
    return res.status(500).json({ ok: false, error: 'prefs_unavailable' });
  }
});

router.put('/', async (req, res) => {
  if (!requireUser(req, res)) return;
  const { cadence, timezone } = req.body || {};

  if (cadence !== undefined && !CADENCES.includes(cadence)) {
    return res.status(422).json({ ok: false, error: 'invalid_cadence' });
  }
  if (timezone !== undefined && timezone !== null && !isValidTimezone(timezone)) {
    return res.status(422).json({ ok: false, error: 'invalid_timezone' });
  }

  try {
    const sets = [];
    const vals = [];
    if (cadence !== undefined)  { sets.push('idea_email_cadence = ?');  vals.push(cadence); }
    if (timezone !== undefined) { sets.push('idea_email_timezone = ?'); vals.push(timezone); }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nothing_to_update' });

    await db.prepare(
      `UPDATE user_profiles SET ${sets.join(', ')}, updated_at = now() WHERE user_id = ?`
    ).run(...vals, req.userId);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[email-prefs] PUT error:', err.message);
    return res.status(500).json({ ok: false, error: 'prefs_save_failed' });
  }
});

module.exports = router;

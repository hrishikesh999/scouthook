'use strict';

/**
 * services/ideaEmails.js — daily ideas email (Phase 2, task 13; spec R6).
 *
 * Hourly cron. For every user whose cadence allows today, sends card #1 of
 * their Daily 3 in a 7–10am window in THEIR timezone (idea_email_timezone,
 * default America/New_York). The 3-hour window + email_log dedup makes the
 * cron restart-safe: a missed 7am tick is caught at 8 or 9, and a double
 * tick can't double-send.
 *
 * Cadence (user_profiles.idea_email_cadence):
 *   'daily'  → every day          '3x' → Mon/Wed/Fri
 *   'weekly' → Monday (also the NULL default — sprint decision: day-1 users
 *              get the lowest-volume cadence until they opt up)
 *   'off'    → never
 *
 * Suppression: skip users who already fed their pipeline in the last 24h
 * (idea action or a generated post) — the email's job is to start the loop,
 * not to nag someone mid-loop.
 *
 * Cards come from today's idea_cards cache (warmed by ideaPrecompute at 6am
 * UTC); on a cache miss we generate synchronously via getDailyCards() —
 * 2-3s of Sonnet latency is fine inside a cron.
 */

const { db } = require('../db');
const { sendEmailToUser } = require('../emails');
const { getDailyCards, logCardEvent } = require('./ideaEngine');

const APP_URL = () => process.env.APP_URL || 'https://app.scouthook.com';
const DEFAULT_TZ = 'America/New_York';
const SEND_FROM_HOUR = 7;
const SEND_TO_HOUR = 10; // exclusive

const TYPE_LABEL = { reach: 'Reach', trust: 'Authority', convert: 'Convert', lead_magnet: 'Lead magnet' };
const URL_TYPE   = { reach: 'reach', trust: 'trust', convert: 'convert', lead_magnet: 'lead_gen' };
const CADENCE_LABEL = { daily: 'daily', '3x': '3× a week', weekly: 'weekly' };

/** Local hour / weekday / date for an IANA timezone. Falls back to DEFAULT_TZ. */
function localClock(tz) {
  for (const zone of [tz, DEFAULT_TZ]) {
    if (!zone) continue;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hour12: false,
        hour: 'numeric', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date());
      const get = t => parts.find(p => p.type === t)?.value;
      return {
        hour: Number(get('hour')) % 24,
        weekday: get('weekday'),                                   // 'Mon' | 'Tue' | ...
        date: `${get('year')}-${get('month')}-${get('day')}`,      // local YYYY-MM-DD
      };
    } catch { /* invalid zone — try fallback */ }
  }
  return null;
}

function cadenceAllowsToday(cadence, weekday) {
  switch (cadence || 'weekly') {
    case 'daily':  return true;
    case '3x':     return ['Mon', 'Wed', 'Fri'].includes(weekday);
    case 'weekly': return weekday === 'Mon';
    default:       return false; // 'off' or unknown
  }
}

async function actedInLast24h(userId) {
  const [event, post] = await Promise.all([
    db.prepare(`
      SELECT id FROM platform_events
      WHERE  user_id = ?
        AND  event_type IN ('idea_card_saved', 'idea_card_clicked', 'idea_card_generated', 'idea_question_answered')
        AND  created_at > now() - INTERVAL '24 hours'
      LIMIT  1
    `).get(userId),
    db.prepare(`
      SELECT id FROM generated_posts
      WHERE  user_id = ? AND created_at > now() - INTERVAL '24 hours'
      LIMIT  1
    `).get(userId),
  ]);
  return !!(event || post);
}

/** Today's cards for a workspace — cache first, sync generation as fallback. */
async function getTodaysCards(userId, workspaceId) {
  const cached = await db.prepare(`
    SELECT id, hook, textarea_input, post_type, provenance_label, is_question, status
    FROM   idea_cards
    WHERE  tenant_id = ? AND served_on = CURRENT_DATE
    ORDER  BY id
  `).all(workspaceId);
  if (cached.length) return cached;
  const { cards } = await getDailyCards(userId, workspaceId);
  return cards;
}

function buildVars(card, cardCount, cadence) {
  const appUrl = APP_URL();
  const hook = String(card.hook || '').trim();
  const writeParams = new URLSearchParams({
    type: URL_TYPE[card.post_type] || 'reach',
    idea: card.is_question ? hook : (card.textarea_input || hook),
    idea_card: String(card.id),
  });
  const others = Math.max(0, cardCount - 1);
  return {
    app_url: appUrl,
    header_label: card.is_question ? 'Today\'s question' : 'Today\'s idea',
    card_hook: hook.length > 90 ? hook.slice(0, 87).trimEnd() + '…' : hook,
    card_type_label: card.is_question ? 'Question' : (TYPE_LABEL[card.post_type] || 'Reach'),
    card_provenance: card.provenance_label || 'Picked for you',
    write_url: `${appUrl}/generate.html?${writeParams.toString()}`,
    more_ideas_line: others > 0
      ? `${others} more idea${others === 1 ? '' : 's'} waiting on your dashboard.`
      : 'More ideas waiting on your dashboard.',
    cadence_label: CADENCE_LABEL[cadence || 'weekly'] || 'weekly',
  };
}

async function runIdeaEmailCron() {
  let candidates;
  try {
    candidates = await db.prepare(`
      SELECT up.user_id, up.idea_email_cadence, up.idea_email_timezone,
             COALESCE(
               up.last_active_workspace_id,
               (SELECT w.id
                FROM   workspaces w
                JOIN   workspace_members wm ON wm.workspace_id = w.id
                WHERE  wm.user_id = up.user_id AND wm.role = 'owner' AND w.deleted_at IS NULL
                ORDER  BY w.created_at ASC LIMIT 1)
             ) AS workspace_id
      FROM   user_profiles up
      JOIN   user_subscriptions us ON us.user_id = up.user_id
      WHERE  up.email IS NOT NULL
        AND  COALESCE(up.idea_email_cadence, 'weekly') <> 'off'
        AND  us.status IN ('active', 'trialing', 'lifetime')
        AND  (us.status <> 'trialing' OR us.trial_ends_at > now())
    `).all();
  } catch (err) {
    console.warn('[idea-emails] cron query error (non-fatal):', err.message);
    return;
  }

  for (const u of candidates) {
    try {
      if (!u.workspace_id) continue;

      const clock = localClock(u.idea_email_timezone);
      if (!clock || clock.hour < SEND_FROM_HOUR || clock.hour >= SEND_TO_HOUR) continue;
      if (!cadenceAllowsToday(u.idea_email_cadence, clock.weekday)) continue;

      // Explicit dedup up front (sendEmailToUser would catch it too, but this
      // skips the card work AND keeps the idea_email_sent event honest on the
      // 8/9am catch-up ticks).
      const dedupKey = `daily-ideas:${clock.date}`;
      const dupe = await db.prepare(`
        SELECT id FROM email_log
        WHERE  user_id = ? AND template = 'daily-ideas' AND dedup_key = ?
          AND  sent_at > now() - INTERVAL '24 hours'
        LIMIT  1
      `).get(u.user_id, dedupKey);
      if (dupe) continue;

      if (await actedInLast24h(u.user_id)) continue;

      const cards = (await getTodaysCards(u.user_id, u.workspace_id))
        .filter(c => c.status !== 'dismissed');
      if (!cards.length) continue;
      // Card #1: first regular card; a question card only if that's all there is
      const card = cards.find(c => !c.is_question) || cards[0];

      await sendEmailToUser(
        u.user_id,
        'daily-ideas',
        buildVars(card, cards.length, u.idea_email_cadence),
        { dedupKey, withinHours: 24 }
      );
      logCardEvent('idea_email_sent', u.user_id, u.workspace_id, {
        idea_card_id: Number(card.id),
        cadence: u.idea_email_cadence || 'weekly',
      });
    } catch (err) {
      console.warn(`[idea-emails] failed for userId=${u.user_id} (non-fatal):`, err.message);
    }
  }
}

module.exports = { runIdeaEmailCron };

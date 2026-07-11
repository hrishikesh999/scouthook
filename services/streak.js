'use strict';

/**
 * services/streak.js — "Consistency" counter (Idea Engine Phase 2, spec R7).
 *
 * A day counts when the user contributed to their content pipeline: saved an
 * idea card, answered a daily question, or generated a post. The bar is
 * "fed the pipeline", not "published" — publishing pressure is what the
 * professional framing is trying to avoid.
 *
 * Day boundary is midnight UTC for everyone (sprint decision: daily, not
 * rolling). Reset is lazy — getStreak() reports 0 when streak_last_date is
 * older than yesterday; no cron mutates rows.
 */

const { db } = require('../db');
const { logCardEvent } = require('./ideaEngine');

/**
 * Record a qualifying action (fire-and-forget — call sites never await).
 * Same-day repeats are no-ops; a yesterday continuation increments; anything
 * older starts over at 1. All date math happens in Postgres so app-server
 * clock skew can't split a day.
 */
function recordStreakAction(userId, tenantId, action) {
  Promise.resolve(
    db.prepare(`
      UPDATE user_profiles
      SET streak_count = CASE
            WHEN streak_last_date = CURRENT_DATE                THEN streak_count
            WHEN streak_last_date = CURRENT_DATE - INTERVAL '1 day' THEN streak_count + 1
            ELSE 1
          END,
          streak_last_date = CURRENT_DATE,
          updated_at = now()
      WHERE user_id = ?
        AND (streak_last_date IS NULL OR streak_last_date < CURRENT_DATE)
      RETURNING streak_count
    `).get(userId)
  ).then(row => {
    // Row only returns on the first qualifying action of the day — exactly one
    // streak event per user per day (north-star instrumentation, DoD Task 10).
    if (row) {
      logCardEvent('streak_incremented', userId, tenantId, {
        streak_count: Number(row.streak_count),
        action: action || null,
      });
    }
  }).catch(err => console.error('[streak] recordStreakAction failed (non-fatal):', err.message));
}

/**
 * getStreak(userId) → { streak_count, active_today }
 * active_today: the user already banked today — UI shows "counted today ✓".
 */
async function getStreak(userId) {
  const row = await db.prepare(`
    SELECT streak_count,
           streak_last_date = CURRENT_DATE                                        AS active_today,
           streak_last_date >= CURRENT_DATE - INTERVAL '1 day'                    AS alive
    FROM   user_profiles
    WHERE  user_id = ?
  `).get(userId);
  if (!row || !row.alive) return { streak_count: 0, active_today: false };
  return { streak_count: Number(row.streak_count), active_today: !!row.active_today };
}

module.exports = { recordStreakAction, getStreak };

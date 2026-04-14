'use strict';

/**
 * routes/funnel.js — Funnel Intelligence API
 *
 * GET /api/funnel/health
 *   Returns the user's 30-day funnel balance across published + drafted posts,
 *   compares against the 70/20/10 target, and suggests the next post type to create.
 */

const express = require('express');
const router  = express.Router();
const { db }  = require('../db');

const TARGET = { reach: 70, trust: 20, convert: 10 };

// Funnel type → recipe suggestion (maps to existing seeded recipes)
const RECIPE_SUGGESTION = {
  reach:   { slug: 'the_prediction',                name: 'The Prediction',                  category: 'perspective' },
  trust:   { slug: 'framework_nobody_talks_about',   name: 'The Framework Nobody Talks About', category: 'credibility' },
  convert: { slug: 'client_conversation',            name: 'The Client Conversation',          category: 'connection'  },
};

// ---------------------------------------------------------------------------
// GET /api/funnel/health
// ---------------------------------------------------------------------------
router.get('/health', async (req, res) => {
  const { userId, tenantId } = req;
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  // Count generated posts by funnel_type in the last 30 days
  const rows = await db.prepare(`
    SELECT funnel_type, COUNT(*) AS cnt
    FROM   generated_posts
    WHERE  user_id   = ?
      AND  tenant_id = ?
      AND  funnel_type IS NOT NULL
      AND  created_at >= now() - interval '30 days'
    GROUP  BY funnel_type
  `).all(userId, tenantId);

  const counts = { reach: 0, trust: 0, convert: 0 };
  for (const row of rows) {
    if (row.funnel_type in counts) counts[row.funnel_type] = Number(row.cnt);
  }

  const total = counts.reach + counts.trust + counts.convert;

  // Actual percentages (0 if no posts yet)
  const actual = {
    reach:   total > 0 ? Math.round((counts.reach   / total) * 100) : 0,
    trust:   total > 0 ? Math.round((counts.trust   / total) * 100) : 0,
    convert: total > 0 ? Math.round((counts.convert / total) * 100) : 0,
  };

  // Find most underrepresented type (largest gap from target)
  let nextSuggested = 'trust';
  let maxGap = -Infinity;
  for (const type of ['reach', 'trust', 'convert']) {
    const gap = TARGET[type] - actual[type];
    if (gap > maxGap) {
      maxGap = gap;
      nextSuggested = type;
    }
  }

  return res.json({
    ok: true,
    counts,
    total,
    actual,
    target:         TARGET,
    nextSuggested,
    suggestedRecipe: RECIPE_SUGGESTION[nextSuggested],
  });
});

module.exports = router;

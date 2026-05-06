'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');

const VALID_TAGS = new Set(['strong', 'decent', 'weak']);

// POST /api/posts/:postId/performance
// Body: { tag: 'strong'|'decent'|'weak', note?: string }
router.post('/:postId/performance', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId || 'default';
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const postId = parseInt(req.params.postId, 10);
  if (!Number.isFinite(postId)) return res.status(400).json({ ok: false, error: 'invalid_id' });

  const { tag, note } = req.body || {};
  if (!VALID_TAGS.has(tag)) return res.status(400).json({ ok: false, error: 'invalid_tag' });

  try {
    const result = await db.prepare(`
      UPDATE generated_posts
      SET    performance_tag       = ?,
             performance_note      = ?,
             performance_tagged_at = now()
      WHERE  id = ? AND user_id = ? AND tenant_id = ? AND status = 'published'
      RETURNING id
    `).run(tag, note?.slice(0, 500) || null, postId, userId, tenantId);

    if (!result.rowCount && result.changes === 0) {
      return res.status(404).json({ ok: false, error: 'post_not_found' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[performance] POST error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/posts/performance-summary
// Returns aggregated performance data for the Content Intelligence dashboard card.
router.get('/performance-summary', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId || 'default';
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  try {
    // Total tagged posts
    const countRow = await db.prepare(`
      SELECT COUNT(*) AS total
      FROM   generated_posts
      WHERE  user_id = ? AND tenant_id = ? AND performance_tag IS NOT NULL
    `).get(userId, tenantId);
    const total = countRow?.total || 0;

    if (total < 3) {
      return res.json({ ok: true, enough_data: false, total_tagged: total });
    }

    // Best archetype by strong rate
    const archetypes = await db.prepare(`
      SELECT archetype_used,
             COUNT(*) AS total,
             SUM(CASE WHEN performance_tag = 'strong' THEN 1 ELSE 0 END) AS strong_count
      FROM   generated_posts
      WHERE  user_id = ? AND tenant_id = ? AND performance_tag IS NOT NULL
        AND  archetype_used IS NOT NULL
      GROUP  BY archetype_used
      ORDER  BY strong_count DESC, total DESC
      LIMIT  3
    `).all(userId, tenantId);

    // Best day of week by strong rate
    const days = await db.prepare(`
      SELECT TO_CHAR(published_at AT TIME ZONE 'UTC', 'Day') AS day_name,
             COUNT(*) AS total,
             SUM(CASE WHEN performance_tag = 'strong' THEN 1 ELSE 0 END) AS strong_count
      FROM   generated_posts
      WHERE  user_id = ? AND tenant_id = ? AND performance_tag IS NOT NULL
        AND  published_at IS NOT NULL
      GROUP  BY day_name
      ORDER  BY strong_count DESC, total DESC
      LIMIT  1
    `).get(userId, tenantId);

    // Untagged published posts (for rating nudge)
    const untagged = await db.prepare(`
      SELECT id, content, published_at, archetype_used, funnel_type
      FROM   generated_posts
      WHERE  user_id = ? AND tenant_id = ? AND status = 'published'
        AND  performance_tag IS NULL
      ORDER  BY published_at DESC
      LIMIT  5
    `).all(userId, tenantId);

    return res.json({
      ok:           true,
      enough_data:  true,
      total_tagged: total,
      archetypes:   archetypes || [],
      best_day:     days || null,
      untagged:     untagged || [],
    });
  } catch (err) {
    console.error('[performance] GET summary error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/posts/untagged-published
// Returns published posts without a performance tag (for rating nudge).
router.get('/untagged-published', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId || 'default';
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  try {
    const posts = await db.prepare(`
      SELECT id, content, published_at, archetype_used, funnel_type
      FROM   generated_posts
      WHERE  user_id = ? AND tenant_id = ? AND status = 'published'
        AND  performance_tag IS NULL
      ORDER  BY published_at DESC
      LIMIT  5
    `).all(userId, tenantId);

    return res.json({ ok: true, posts });
  } catch (err) {
    console.error('[performance] GET untagged error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

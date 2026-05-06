'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { removeScheduledJob } = require('../services/scheduler');

// ---------------------------------------------------------------------------
// GET /api/stats
// Returns post count this month, avg quality score, scheduled count
// ---------------------------------------------------------------------------
router.get('/stats', async (req, res) => {
  if (!req.userId) {
    return res.status(400).json({ ok: false, error: 'missing_user_id' });
  }

  try {
    // Posts generated this calendar month
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthStartIso = monthStart.toISOString();

    const postsThisMonth = await db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM generated_posts
      WHERE user_id = ? AND tenant_id = ? AND created_at >= ?
    `).get(req.userId, req.tenantId, monthStartIso);

    // Average quality score across all posts
    const avgScore = await db.prepare(`
      SELECT AVG(quality_score) AS avg
      FROM generated_posts
      WHERE user_id = ? AND tenant_id = ?
    `).get(req.userId, req.tenantId);

    // Count of pending scheduled posts
    const scheduledCount = await db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM scheduled_posts
      WHERE user_id = ? AND tenant_id = ? AND status = 'pending'
    `).get(req.userId, req.tenantId);

    return res.json({
      ok: true,
      posts_this_month: postsThisMonth.cnt,
      avg_quality_score: avgScore.avg !== null ? Math.round(avgScore.avg) : null,
      scheduled_count: scheduledCount.cnt
    });
  } catch (err) {
    console.error('[stats] GET /api/stats error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/posts/recent
// Returns last 5 generated posts for the user
// ---------------------------------------------------------------------------
router.get('/posts/recent', async (req, res) => {
  if (!req.userId) {
    return res.status(400).json({ ok: false, error: 'missing_user_id' });
  }

  try {
    const posts = await db.prepare(`
      SELECT id, content, quality_score, passed_gate, created_at, status,
             archetype_used, published_at, performance_tag
      FROM generated_posts
      WHERE user_id = ? AND tenant_id = ? AND status != 'scheduled'
      ORDER BY created_at DESC
      LIMIT 5
    `).all(req.userId, req.tenantId);

    const mapped = posts.map(p => ({
      id:              p.id,
      content:         p.content,
      quality_score:   p.quality_score,
      passed_gate:     p.passed_gate,
      created_at:      p.created_at,
      status:          p.status || 'draft',
      archetype_used:  p.archetype_used || null,
      published_at:    p.published_at || null,
      performance_tag: p.performance_tag || null,
    }));

    return res.json({ ok: true, posts: mapped });
  } catch (err) {
    console.error('[stats] GET /api/posts/recent error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/posts/scheduled
// Returns upcoming scheduled posts (status = pending, scheduled_for > now)
// ---------------------------------------------------------------------------
router.get('/posts/scheduled', async (req, res) => {
  if (!req.userId) {
    return res.status(400).json({ ok: false, error: 'missing_user_id' });
  }

  try {
    const nowIso = new Date().toISOString();

    const posts = await db.prepare(`
      SELECT id, content, scheduled_for, created_at
      FROM scheduled_posts
      WHERE user_id = ? AND tenant_id = ? AND status = 'pending' AND scheduled_for > ?
      ORDER BY scheduled_for ASC
      LIMIT 5
    `).all(req.userId, req.tenantId, nowIso);

    const mapped = posts.map(p => ({
      id:            p.id,
      content:       p.content,
      scheduled_for: p.scheduled_for,
      quality_score: null,
      status:        'scheduled'
    }));

    return res.json({ ok: true, posts: mapped });
  } catch (err) {
    console.error('[stats] GET /api/posts/scheduled error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/posts/:id
// Fetches a single post by ID — used by generate.html when opened via ?postId=
// ---------------------------------------------------------------------------
router.get('/posts/:id', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId || 'default';
  const postId   = req.params.id;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  try {
    // Try full query including asset columns (added in migration 007).
    // Fall back to the pre-migration column set if those columns don't exist yet.
    let post;
    try {
      post = await db.prepare(`
        SELECT id, content, format_slug, quality_score, quality_flags, passed_gate, status, created_at,
               idea_input, funnel_type, asset_url, asset_preview_url, asset_type, asset_slide_count
        FROM   generated_posts
        WHERE  id = ? AND user_id = ? AND tenant_id = ?
      `).get(postId, userId, tenantId);
    } catch {
      post = await db.prepare(`
        SELECT id, content, format_slug, quality_score, quality_flags, passed_gate, status, created_at,
               idea_input, funnel_type
        FROM   generated_posts
        WHERE  id = ? AND user_id = ? AND tenant_id = ?
      `).get(postId, userId, tenantId);
    }

    if (!post) return res.status(404).json({ ok: false, error: 'post_not_found' });

    const sched = await db.prepare(`
      SELECT id AS scheduled_post_id, scheduled_for, status AS scheduled_status, first_comment
      FROM   scheduled_posts
      WHERE  post_id = ? AND user_id = ? AND tenant_id = ? AND status IN ('pending', 'processing')
    `).get(postId, userId, tenantId);

    const payload = {
      ...post,
      scheduled_post_id: sched?.scheduled_post_id ?? null,
      scheduled_for:     sched?.scheduled_for ?? null,
      scheduled_status:  sched?.scheduled_status ?? null,
      first_comment:     sched?.first_comment ?? null,
    };

    return res.json({ ok: true, post: payload });
  } catch (err) {
    console.error('[stats] GET /api/posts/:id error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/posts/:id
// Updates the content of a generated post (for Save Draft)
// ---------------------------------------------------------------------------
router.patch('/posts/:id', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId || 'default';
  const postId   = req.params.id;
  const { content, idea_input, first_comment,
          asset_url, asset_preview_url, asset_type, asset_slide_count } = req.body;

  if (!userId)  return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!content) return res.status(400).json({ ok: false, error: 'missing_content' });

  try {
    const existing = await db.prepare(`
      SELECT status FROM generated_posts
      WHERE id = ? AND user_id = ? AND tenant_id = ?
    `).get(postId, userId, tenantId);

    if (!existing) return res.status(404).json({ ok: false, error: 'post_not_found' });
    if (existing.status !== 'draft') {
      return res.status(409).json({ ok: false, error: 'post_not_editable', status: existing.status });
    }

    // Asset fields are passed explicitly (including null to clear them).
    // Only update when the caller included them in the request body.
    const hasAsset = 'asset_url' in req.body;

    const firstCommentVal = 'first_comment' in req.body ? (first_comment?.trim() || null) : undefined;

    const result = hasAsset
      ? await db.prepare(`
          UPDATE generated_posts
          SET content           = ?,
              idea_input        = COALESCE(?, idea_input),
              first_comment     = COALESCE(?, first_comment),
              asset_url         = ?,
              asset_preview_url = ?,
              asset_type        = ?,
              asset_slide_count = ?
          WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'draft'
        `).run(content, idea_input ?? null, firstCommentVal ?? null,
               asset_url ?? null, asset_preview_url ?? null,
               asset_type ?? null, asset_slide_count ?? null,
               postId, userId, tenantId)
      : await db.prepare(`
          UPDATE generated_posts
          SET content       = ?,
              idea_input    = COALESCE(?, idea_input),
              first_comment = COALESCE(?, first_comment)
          WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'draft'
        `).run(content, idea_input ?? null, firstCommentVal ?? null, postId, userId, tenantId);

    if (result.changes === 0) {
      return res.status(409).json({ ok: false, error: 'post_not_editable' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[stats] PATCH /api/posts/:id error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/posts/:id  and  POST /api/posts/:id/delete
// Removes a draft and dependent rows (copy_events, scheduled_posts).
// POST alias: some proxies block DELETE; clients may use POST instead.
// ---------------------------------------------------------------------------
async function handleDeleteDraft(req, res) {
  const userId   = req.userId;
  const tenantId = req.tenantId || 'default';
  const postId   = Number(req.params.id);

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!Number.isFinite(postId)) return res.status(400).json({ ok: false, error: 'invalid_id' });

  try {
    const existing = await db.prepare(`
      SELECT id, status FROM generated_posts
      WHERE id = ? AND user_id = ? AND tenant_id = ?
    `).get(postId, userId, tenantId);

    if (!existing) return res.status(404).json({ ok: false, error: 'post_not_found' });

    if (existing.status === 'scheduled') {
      return res.status(409).json({ ok: false, error: 'cannot_delete_scheduled_post' });
    }

    const activeSchedule = await db.prepare(`
      SELECT id FROM scheduled_posts
      WHERE post_id = ? AND user_id = ? AND tenant_id = ? AND status IN ('pending', 'processing')
    `).get(postId, userId, tenantId);

    if (activeSchedule) {
      return res.status(409).json({ ok: false, error: 'cannot_delete_scheduled_post' });
    }

    if (existing.status !== 'draft') {
      return res.status(400).json({ ok: false, error: 'only_drafts_deletable' });
    }

    const schedRows = await db.prepare(`
      SELECT id FROM scheduled_posts
      WHERE post_id = ? AND user_id = ? AND tenant_id = ?
    `).all(postId, userId, tenantId);

    for (const row of schedRows) {
      try {
        await removeScheduledJob(Number(row.id));
      } catch (e) {
        console.warn('[stats] removeScheduledJob', row.id, e.message);
      }
    }

    await db.transaction(async tx => {
      await tx.prepare(`
        DELETE FROM scheduled_post_events
        WHERE scheduled_post_id IN (
          SELECT id FROM scheduled_posts
          WHERE post_id = ? AND user_id = ? AND tenant_id = ?
        )
      `).run(postId, userId, tenantId);
      await tx.prepare('DELETE FROM copy_events WHERE post_id = ?').run(postId);
      await tx.prepare(`
        DELETE FROM scheduled_posts
        WHERE post_id = ? AND user_id = ? AND tenant_id = ?
      `).run(postId, userId, tenantId);
      const r = await tx.prepare(`
        DELETE FROM generated_posts
        WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = ?
      `).run(postId, userId, tenantId, 'draft');
      if (r.changes === 0) throw new Error('delete_failed');
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[stats] delete draft error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

router.delete('/posts/:id', handleDeleteDraft);
router.post('/posts/:id/delete', handleDeleteDraft);

// ---------------------------------------------------------------------------
// GET /api/posts[?status=draft|published]
// Returns generated posts for the user filtered by status (default: draft).
// When status=published, also returns metrics and linkedin_post_id columns.
// ---------------------------------------------------------------------------
router.get('/posts', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId || 'default';
  const status   = req.query.status === 'published' ? 'published' : 'draft';
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  try {
    let posts;
    if (status === 'published') {
      posts = await db.prepare(`
        SELECT id, content, format_slug, likes, comments, reactions,
               published_at, last_synced_at, linkedin_post_id, asset_type, funnel_type
        FROM   generated_posts
        WHERE  user_id = ? AND tenant_id = ? AND status = 'published'
        ORDER  BY published_at DESC
      `).all(userId, tenantId);
    } else {
      posts = await db.prepare(`
        SELECT id, content, quality_score, passed_gate, format_slug, status, created_at, funnel_type, first_comment
        FROM   generated_posts
        WHERE  user_id = ? AND tenant_id = ? AND status = 'draft'
        ORDER  BY created_at DESC
      `).all(userId, tenantId);
    }

    return res.json({ ok: true, posts });
  } catch (err) {
    console.error('[stats] GET /api/posts error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

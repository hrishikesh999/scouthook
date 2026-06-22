'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { removeScheduledJob } = require('../services/scheduler');
const { captureVoiceRefinement } = require('../services/voiceExtraction');
const { runQualityGate }        = require('../services/qualityGate');

// Lightweight Levenshtein distance — used only for edit-ratio comparison.
// Uses single-array DP for O(min(m,n)) space. Safe for post-length strings (~500 chars).
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Ensure a is the shorter string
  if (a.length > b.length) { [a, b] = [b, a]; }
  let row = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = j;
    for (let i = 1; i <= a.length; i++) {
      const val = b[j - 1] === a[i - 1]
        ? row[i - 1]
        : 1 + Math.min(row[i - 1], row[i], prev);
      row[i - 1] = prev;
      prev = val;
    }
    row[a.length] = prev;
  }
  return row[a.length];
}

// Multi-dimensional change detection — returns array of change type strings.
// Each type triggers a focused rule extraction in captureVoiceRefinement.
function detectChangeTypes(oldText, newText) {
  const types = [];

  // 1. Structural: opening sentence changed
  const oldFirst = (oldText.split(/[.!?](?:\s|$)/)[0] || '').trim();
  const newFirst = (newText.split(/[.!?](?:\s|$)/)[0] || '').trim();
  if (oldFirst.length > 10 && oldFirst !== newFirst) {
    types.push('hook');
  }

  // 2. Vocabulary: 3+ unique meaningful words substituted
  const tokenise = t => new Set(t.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const oldWords = tokenise(oldText);
  const newWords = tokenise(newText);
  const removed = [...oldWords].filter(w => !newWords.has(w)).length;
  const added   = [...newWords].filter(w => !oldWords.has(w)).length;
  if (removed >= 3 && added >= 3) {
    types.push('vocabulary');
  }

  // 3. Length: ≥20% shorter or longer
  const lenDelta = Math.abs(newText.length - oldText.length) / Math.max(oldText.length, 1);
  if (lenDelta >= 0.20) {
    types.push('length');
  }

  // 4. General catch-all via Levenshtein (only when no specific type detected)
  if (types.length === 0) {
    const maxLen = Math.max(oldText.length, newText.length);
    if (maxLen > 0 && levenshteinDistance(oldText, newText) / maxLen > 0.30) {
      types.push('general');
    }
  }

  return types;
}

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

    const yearStart = new Date().getFullYear() + '-01-01T00:00:00.000Z';

    const [postsThisMonth, postsYtd, scheduledCount, draftCount] = await Promise.all([
      db.prepare(`
        SELECT COUNT(*) AS cnt FROM generated_posts
        WHERE tenant_id = ? AND created_at >= ?
      `).get(req.tenantId, monthStartIso),
      db.prepare(`
        SELECT COUNT(*) AS cnt FROM generated_posts
        WHERE tenant_id = ? AND created_at >= ?
      `).get(req.tenantId, yearStart),
      db.prepare(`
        SELECT COUNT(*) AS cnt FROM scheduled_posts
        WHERE tenant_id = ? AND status = 'pending'
      `).get(req.tenantId),
      db.prepare(`
        SELECT COUNT(*) AS cnt FROM generated_posts
        WHERE tenant_id = ? AND status = 'draft'
      `).get(req.tenantId),
    ]);

    return res.json({
      ok: true,
      posts_this_month: postsThisMonth.cnt,
      posts_ytd: postsYtd.cnt,
      scheduled_count: scheduledCount.cnt,
      draft_count: draftCount.cnt,
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
      SELECT id, content, passed_gate, created_at, status,
             archetype_used, published_at, performance_tag
      FROM generated_posts
      WHERE tenant_id = ? AND status != 'scheduled'
      ORDER BY created_at DESC
      LIMIT 5
    `).all(req.tenantId);

    const mapped = posts.map(p => ({
      id:              p.id,
      content:         p.content,
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
      WHERE tenant_id = ? AND status = 'pending' AND scheduled_for > ?
      ORDER BY scheduled_for ASC
      LIMIT 5
    `).all(req.tenantId, nowIso);

    const mapped = posts.map(p => ({
      id:            p.id,
      content:       p.content,
      scheduled_for: p.scheduled_for,
      status:        'scheduled'
    }));

    return res.json({ ok: true, posts: mapped });
  } catch (err) {
    console.error('[stats] GET /api/posts/scheduled error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/posts/mix-recommendation
// Returns recommended post type based on 50/30/20 target (reach/trust/convert).
// Lead magnet excluded from mix calc.
// Must be defined before /posts/:id to avoid the parameterized route capturing it.
// ---------------------------------------------------------------------------
router.get('/posts/mix-recommendation', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  try {
    const rows = await db.prepare(`
      SELECT post_type, COUNT(*) AS n
      FROM   generated_posts
      WHERE  tenant_id = ?
        AND  status = 'published'
        AND  post_type IN ('reach', 'trust', 'convert')
        AND  published_at > NOW() - INTERVAL '30 days'
      GROUP  BY post_type
    `).all(tenantId);

    const total = rows.reduce((s, r) => s + Number(r.n), 0);

    if (total < 4) {
      return res.json({ ok: true, has_enough_data: false, recommended_type: null, nudge: null });
    }

    const counts = { reach: 0, trust: 0, convert: 0 };
    for (const row of rows) counts[row.post_type] = Number(row.n);

    const targets = { reach: 0.50, trust: 0.30, convert: 0.20 };
    let worstType = null;
    let worstDelta = -Infinity;

    for (const [type, target] of Object.entries(targets)) {
      const actual = counts[type] / total;
      const delta = target - actual; // positive = underweight
      if (delta > worstDelta) {
        worstDelta = delta;
        worstType = type;
      }
    }

    const lastTypes = rows.sort((a, b) => Number(b.n) - Number(a.n)).map(r => r.post_type);
    const dominantType = lastTypes[0] || null;
    const nudge = dominantType && dominantType !== worstType
      ? `Your last ${total} posts were mostly ${dominantType} — time to balance your mix?`
      : null;

    return res.json({
      ok: true,
      has_enough_data: true,
      recommended_type: worstType,
      nudge,
    });
  } catch (err) {
    console.error('[stats] GET /api/posts/mix-recommendation error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/posts/:id
// Fetches a single post by ID — used by generate.html when opened via ?postId=
// ---------------------------------------------------------------------------
router.get('/posts/:id', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  const postId   = req.params.id;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!/^\d+$/.test(postId)) return res.status(400).json({ ok: false, error: 'invalid_id' });

  try {
    // Try full query including asset columns (added in migration 007).
    // Fall back to the pre-migration column set if those columns don't exist yet.
    let post;
    try {
      post = await db.prepare(`
        SELECT id, content, format_slug, quality_score, quality_flags, passed_gate, status, created_at,
               idea_input, funnel_type, asset_url, asset_preview_url, asset_type, asset_slide_count,
               published_at, linkedin_post_id, performance_tag, performance_note, archetype_used
        FROM   generated_posts
        WHERE  id = ? AND tenant_id = ?
      `).get(postId, tenantId);
    } catch {
      post = await db.prepare(`
        SELECT id, content, format_slug, quality_score, quality_flags, passed_gate, status, created_at,
               idea_input, funnel_type
        FROM   generated_posts
        WHERE  id = ? AND tenant_id = ?
      `).get(postId, tenantId);
    }

    if (!post) return res.status(404).json({ ok: false, error: 'post_not_found' });

    const sched = await db.prepare(`
      SELECT id AS scheduled_post_id, scheduled_for, status AS scheduled_status, first_comment
      FROM   scheduled_posts
      WHERE  post_id = ? AND tenant_id = ? AND status IN ('pending', 'processing')
    `).get(postId, tenantId);

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
  const tenantId = req.tenantId;
  const postId   = req.params.id;
  const { content, idea_input, first_comment,
          asset_url, asset_preview_url, asset_type, asset_slide_count } = req.body;

  if (!userId)  return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!content) return res.status(400).json({ ok: false, error: 'missing_content' });

  try {
    const existing = await db.prepare(`
      SELECT status, content AS old_content, profile_id,
             format_slug, funnel_type, archetype_used, post_type, lead_magnet_inputs
      FROM generated_posts
      WHERE id = ? AND tenant_id = ?
    `).get(postId, tenantId);

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
          WHERE id = ? AND tenant_id = ? AND status = 'draft'
        `).run(content, idea_input ?? null, firstCommentVal ?? null,
               asset_url ?? null, asset_preview_url ?? null,
               asset_type ?? null, asset_slide_count ?? null,
               postId, tenantId)
      : await db.prepare(`
          UPDATE generated_posts
          SET content       = ?,
              idea_input    = COALESCE(?, idea_input),
              first_comment = COALESCE(?, first_comment)
          WHERE id = ? AND tenant_id = ? AND status = 'draft'
        `).run(content, idea_input ?? null, firstCommentVal ?? null, postId, tenantId);

    if (result.changes === 0) {
      return res.status(409).json({ ok: false, error: 'post_not_editable' });
    }

    // Voice refinement capture — fire-and-forget, multi-dimensional change detection
    let voiceRefined = false;
    const oldContent = existing.old_content || '';
    if (oldContent && content) {
      const changeTypes = detectChangeTypes(oldContent, content);
      if (changeTypes.length > 0) {
        if (existing.profile_id) {
          captureVoiceRefinement(existing.profile_id, oldContent, content, changeTypes).catch(() => {});
        }
        voiceRefined = true;
      }
    }

    // Re-run quality gate on updated content and persist
    let qualityPayload = null;
    try {
      const profileRow  = await db.prepare(
        `SELECT voice_fingerprint, content_niche FROM profiles WHERE workspace_id = ? AND is_default = true`
      ).get(tenantId);
      const voiceProfile = profileRow || {};
      let lmKeyword = null;
      try { lmKeyword = JSON.parse(existing.lead_magnet_inputs || 'null')?.keyword || null; } catch {}
      const gate = runQualityGate(content, {
        voiceProfile,
        formatSlug:  existing.format_slug || '',
        funnelType:  existing.funnel_type || null,
        postType:    existing.post_type   || null,
        keyword:     lmKeyword,
      });
      await db.prepare(`
        UPDATE generated_posts
        SET quality_score = ?, quality_flags = ?, passed_gate = ?
        WHERE id = ? AND tenant_id = ?
      `).run(gate.score, JSON.stringify(gate.flags), gate.passed ? 1 : 0, postId, tenantId);
      qualityPayload = {
        score:      gate.score,
        passed:     gate.passed,
        flags:      gate.flags,
        errors:     gate.errors,
        warnings:   gate.warnings,
        verdict:    gate.verdict,
        dimensions: gate.dimensions,
      };
    } catch { /* non-fatal — score update is best-effort */ }

    return res.json({ ok: true, voiceRefined, quality: qualityPayload });
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
  const tenantId = req.tenantId;
  const postId   = Number(req.params.id);

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!Number.isFinite(postId)) return res.status(400).json({ ok: false, error: 'invalid_id' });

  try {
    const existing = await db.prepare(`
      SELECT id, status FROM generated_posts
      WHERE id = ? AND tenant_id = ?
    `).get(postId, tenantId);

    if (!existing) return res.status(404).json({ ok: false, error: 'post_not_found' });

    if (existing.status === 'scheduled') {
      return res.status(409).json({ ok: false, error: 'cannot_delete_scheduled_post' });
    }

    const activeSchedule = await db.prepare(`
      SELECT id FROM scheduled_posts
      WHERE post_id = ? AND tenant_id = ? AND status IN ('pending', 'processing')
    `).get(postId, tenantId);

    if (activeSchedule) {
      return res.status(409).json({ ok: false, error: 'cannot_delete_scheduled_post' });
    }

    if (existing.status !== 'draft') {
      return res.status(400).json({ ok: false, error: 'only_drafts_deletable' });
    }

    const schedRows = await db.prepare(`
      SELECT id FROM scheduled_posts
      WHERE post_id = ? AND tenant_id = ?
    `).all(postId, tenantId);

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
          WHERE post_id = ? AND tenant_id = ?
        )
      `).run(postId, tenantId);
      await tx.prepare('DELETE FROM copy_events WHERE post_id = ? AND tenant_id = ?').run(postId, tenantId);
      await tx.prepare(`
        DELETE FROM scheduled_posts
        WHERE post_id = ? AND tenant_id = ?
      `).run(postId, tenantId);
      const r = await tx.prepare(`
        DELETE FROM generated_posts
        WHERE id = ? AND tenant_id = ? AND status = ?
      `).run(postId, tenantId, 'draft');
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
// PATCH /api/posts/:id/type
// Retroactively tag a post's type (reach | trust | convert). Lead magnet excluded.
// ---------------------------------------------------------------------------
router.patch('/posts/:id/type', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  const postId   = req.params.id;
  const { post_type } = req.body;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });
  if (!['reach', 'trust', 'convert'].includes(post_type)) {
    return res.status(400).json({ ok: false, error: 'invalid_type' });
  }

  try {
    const result = await db.prepare(`
      UPDATE generated_posts SET post_type = ?
      WHERE id = ? AND tenant_id = ?
    `).run(post_type, postId, tenantId);

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: 'post_not_found' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[stats] PATCH /api/posts/:id/type error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/posts[?status=draft|published]
// Returns generated posts for the user filtered by status (default: draft).
// When status=published, also returns metrics and linkedin_post_id columns.
// ---------------------------------------------------------------------------
router.get('/posts', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  const status   = req.query.status === 'published' ? 'published' : 'draft';
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  try {
    let posts;
    if (status === 'published') {
      posts = await db.prepare(`
        SELECT id, content, format_slug, published_at, linkedin_post_id,
               asset_type, funnel_type, performance_tag, archetype_used
        FROM   generated_posts
        WHERE  tenant_id = ? AND status = 'published'
        ORDER  BY published_at DESC
      `).all(tenantId);
    } else {
      posts = await db.prepare(`
        SELECT id, content, quality_score, passed_gate, format_slug, status, created_at, funnel_type, first_comment
        FROM   generated_posts
        WHERE  tenant_id = ? AND status = 'draft'
        ORDER  BY created_at DESC
      `).all(tenantId);
    }

    return res.json({ ok: true, posts });
  } catch (err) {
    console.error('[stats] GET /api/posts error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

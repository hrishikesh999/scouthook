'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { synthesise } = require('../services/synthesise');
const { runQualityGate } = require('../services/qualityGate');
const { generateInsightAlternativePost } = require('../services/ideaPath');

// ---------------------------------------------------------------------------
// In-memory sliding window rate limiter — 10 generations per hour per user.
// Shared across /api/generate and /api/generate/regenerate/:postId.
// Resets on server restart (acceptable for a single-server deployment).
// ---------------------------------------------------------------------------
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const generationTimestamps = new Map(); // userId → number[]

function checkRateLimit(userId) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (generationTimestamps.get(userId) || []).filter(t => t > cutoff);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    const retryAfterSec = Math.ceil((timestamps[0] - cutoff) / 1000);
    return { limited: true, retryAfterSec };
  }
  timestamps.push(now);
  generationTimestamps.set(userId, timestamps);
  return { limited: false };
}

function gateOptions(post, userProfile, genPath, archetypeUsed, hookConfidence) {
  return {
    voiceProfile: userProfile,
    archetypeUsed: archetypeUsed ?? null,
    hookConfidence: hookConfidence ?? null,
    formatSlug: post.format_slug,
    path: genPath,
  };
}

function buildQualityPayload(gate, synthesisAttempt, isPrimary) {
  const quality = {
    passed: gate.passed,
    score: gate.score,
    errors: gate.errors,
    warnings: gate.warnings,
    flags: gate.flags,
    recommendation: gate.recommendation,
  };
  if (isPrimary && !gate.passed && synthesisAttempt === 2) {
    quality.forcedReturn = true;
  }
  return quality;
}

/**
 * Recipe path: batch posts + optional one quality retry.
 */
async function synthesiseWithOptionalQualityRetry(userProfile, baseOptions, genPath) {
  let synthesisAttempt = 1;
  let synthResult = await synthesise(userProfile, baseOptions);
  let { synthesis, posts: rawPosts, archetypeUsed, hookConfidence } = synthResult;

  const runGates = posts =>
    posts.map(post => ({
      post,
      gate: runQualityGate(post.content, gateOptions(post, userProfile, genPath, archetypeUsed, hookConfidence)),
    }));

  let gated = runGates(rawPosts);
  const anyHardFail = () => gated.some(g => !g.gate.passed);

  if (anyHardFail() && synthesisAttempt === 1) {
    const errs = [...new Set(gated.filter(g => !g.gate.passed).flatMap(g => g.gate.errors))];
    const qualityRetryHint =
      `The previous attempt failed these quality checks: ${errs.join(', ')}. Fix all of these in your next attempt.`;
    synthesisAttempt = 2;
    synthResult = await synthesise(userProfile, { ...baseOptions, qualityRetryHint });
    ({ synthesis, posts: rawPosts, archetypeUsed, hookConfidence } = synthResult);
    gated = runGates(rawPosts);
  }

  return { synthesis, posts: rawPosts, archetypeUsed, hookConfidence, gated, synthesisAttempt };
}

const IDEA_SLUG = 'idea';
const IDEA_INSIGHT_SLUG = 'idea_insight';

/**
 * Idea path: single primary post + optional INSIGHT alternative after primary passes gate.
 */
async function synthesiseIdeaWithOptionalQualityRetry(userProfile, baseOptions) {
  let synthesisAttempt = 1;
  let synthResult = await synthesise(userProfile, baseOptions);
  let { synthesis, post, archetypeUsed, hookConfidence } = synthResult;

  const gatePrimary = () =>
    runQualityGate(
      post,
      gateOptions({ format_slug: IDEA_SLUG, content: post }, userProfile, 'idea', archetypeUsed, hookConfidence)
    );

  let primaryGate = gatePrimary();

  if (!primaryGate.passed && synthesisAttempt === 1) {
    const qualityRetryHint =
      `The previous attempt failed these quality checks: ${primaryGate.errors.join(', ')}. Fix all of these in your next attempt.`;
    synthesisAttempt = 2;
    synthResult = await synthesise(userProfile, { ...baseOptions, qualityRetryHint });
    ({ synthesis, post, archetypeUsed, hookConfidence } = synthResult);
    primaryGate = gatePrimary();
  }

  let alternative = null;
  if (primaryGate.passed && typeof hookConfidence === 'number' && hookConfidence < 0.7) {
    const altSynth = await generateInsightAlternativePost(baseOptions.rawIdea, userProfile, {});
    const altGate = runQualityGate(
      altSynth.post,
      gateOptions(
        { format_slug: IDEA_INSIGHT_SLUG, content: altSynth.post },
        userProfile,
        'idea',
        'INSIGHT',
        null
      )
    );
    alternative = { post: altSynth.post, archetypeUsed: 'INSIGHT', gate: altGate };
  }

  return {
    synthesis,
    post,
    archetypeUsed,
    hookConfidence,
    primaryGate,
    alternative,
    synthesisAttempt,
  };
}

// ---------------------------------------------------------------------------
// POST /api/generate
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const userId = req.userId;
  const tenantId = req.tenantId;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const rl = checkRateLimit(userId);
  if (rl.limited) {
    return res.status(429).json({ ok: false, error: 'rate_limit_exceeded', retry_after_sec: rl.retryAfterSec });
  }

  const { path: genPath, raw_idea, recipe_slug, answers } = req.body;

  if (!genPath) return res.status(400).json({ ok: false, error: 'missing_path' });

  const userProfile = db
    .prepare('SELECT * FROM user_profiles WHERE user_id = ? AND tenant_id = ?')
    .get(userId, tenantId);

  if (!userProfile) {
    return res.status(400).json({ ok: false, error: 'complete_profile_first' });
  }

  if (genPath === 'idea' && !raw_idea?.trim()) {
    return res.status(400).json({ ok: false, error: 'missing_raw_idea' });
  }
  if (genPath === 'recipe' && (!recipe_slug || !answers || !Array.isArray(answers))) {
    return res.status(400).json({ ok: false, error: 'missing_recipe_fields' });
  }
  if (genPath === 'research') {
    return res.status(400).json({ ok: false, error: 'research_path_phase2_only' });
  }

  try {
    const baseOptions =
      genPath === 'idea'
        ? { rawIdea: raw_idea }
        : { recipeAnswers: { slug: recipe_slug, answers } };

    if (genPath === 'idea') {
      const ideaResult = await synthesiseIdeaWithOptionalQualityRetry(userProfile, baseOptions);
      const {
        synthesis,
        post,
        archetypeUsed,
        hookConfidence,
        primaryGate,
        alternative,
        synthesisAttempt,
      } = ideaResult;

      if (typeof post !== 'string' || !post.trim()) {
        throw new Error('idea path returned no post content');
      }

      const runResult = db.prepare(`
        INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        userId,
        tenantId,
        genPath,
        JSON.stringify({ raw_idea }),
        JSON.stringify(synthesis)
      );
      const runId = runResult.lastInsertRowid;

      const postsInsert = db.prepare(`
        INSERT INTO generated_posts (run_id, user_id, tenant_id, format_slug, content, quality_score, quality_flags, passed_gate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const primaryInsert = postsInsert.run(
        runId,
        userId,
        tenantId,
        IDEA_SLUG,
        post,
        primaryGate.score,
        JSON.stringify(primaryGate.flags),
        primaryGate.passed_gate ? 1 : 0
      );
      const primaryId = primaryInsert.lastInsertRowid;

      const primaryQuality = buildQualityPayload(primaryGate, synthesisAttempt, true);

      let altPayload = null;
      if (alternative) {
        const altInsert = postsInsert.run(
          runId,
          userId,
          tenantId,
          IDEA_INSIGHT_SLUG,
          alternative.post,
          alternative.gate.score,
          JSON.stringify(alternative.gate.flags),
          alternative.gate.passed_gate ? 1 : 0
        );
        const altQuality = buildQualityPayload(alternative.gate, synthesisAttempt, false);
        altPayload = {
          id: altInsert.lastInsertRowid,
          post: alternative.post,
          archetypeUsed: 'INSIGHT',
          quality: altQuality,
        };
      }

      return res.json({
        ok: true,
        run_id: runId,
        synthesis,
        post,
        id: primaryId,
        archetypeUsed,
        hookConfidence,
        quality: primaryQuality,
        alternative: altPayload == null ? null : altPayload,
      });
    }

    const {
      synthesis,
      archetypeUsed,
      hookConfidence,
      gated,
      synthesisAttempt,
    } = await synthesiseWithOptionalQualityRetry(userProfile, baseOptions, genPath);

    const formatMap = {};
    db.prepare("SELECT slug, name FROM post_formats WHERE is_active = 1 AND tenant_id = ?")
      .all(tenantId)
      .forEach(f => { formatMap[f.slug] = f.name; });

    const runResult = db.prepare(`
      INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      userId,
      tenantId,
      genPath,
      JSON.stringify({ recipe_slug, answers }),
      JSON.stringify(synthesis)
    );
    const runId = runResult.lastInsertRowid;

    const postsInsert = db.prepare(`
      INSERT INTO generated_posts (run_id, user_id, tenant_id, format_slug, content, quality_score, quality_flags, passed_gate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const savedPosts = gated.map(({ post: p, gate }) => {
      const insertResult = postsInsert.run(
        runId,
        userId,
        tenantId,
        p.format_slug,
        p.content,
        gate.score,
        JSON.stringify(gate.flags),
        gate.passed_gate ? 1 : 0
      );

      const quality = buildQualityPayload(gate, synthesisAttempt, true);

      return {
        id: insertResult.lastInsertRowid,
        format_slug: p.format_slug,
        format_name: formatMap[p.format_slug] || p.format_slug,
        content: p.content,
        quality_score: gate.score,
        quality_flags: gate.flags,
        passed_gate: gate.passed_gate,
        quality,
      };
    });

    const responseBody = { ok: true, run_id: runId, posts: savedPosts, synthesis };
    if (genPath === 'idea' && archetypeUsed !== undefined) {
      responseBody.archetypeUsed = archetypeUsed;
      responseBody.hookConfidence = hookConfidence;
    }
    return res.json(responseBody);

  } catch (err) {
    console.error('[generate] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/generate/regenerate/:postId
// ---------------------------------------------------------------------------
router.post('/regenerate/:postId', async (req, res) => {
  const userId = req.userId;
  const tenantId = req.tenantId;
  const { postId } = req.params;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const rl = checkRateLimit(userId);
  if (rl.limited) {
    return res.status(429).json({ ok: false, error: 'rate_limit_exceeded', retry_after_sec: rl.retryAfterSec });
  }

  const post = db.prepare(`
    SELECT gp.*, gr.path, gr.input_data
    FROM generated_posts gp
    JOIN generation_runs gr ON gp.run_id = gr.id
    WHERE gp.id = ? AND gp.user_id = ? AND gp.tenant_id = ?
  `).get(postId, userId, tenantId);

  if (!post) return res.status(404).json({ ok: false, error: 'post_not_found' });
  if (post.status !== 'draft') {
    return res.status(409).json({ ok: false, error: 'post_not_editable', status: post.status });
  }

  const userProfile = db
    .prepare('SELECT * FROM user_profiles WHERE user_id = ? AND tenant_id = ?')
    .get(userId, tenantId);

  if (!userProfile) return res.status(400).json({ ok: false, error: 'complete_profile_first' });

  try {
    const inputData = JSON.parse(post.input_data || '{}');
    const failedFlags = JSON.parse(post.quality_flags || '[]');

    const baseOptions = post.path === 'idea'
      ? { rawIdea: inputData.raw_idea }
      : { recipeAnswers: { slug: inputData.recipe_slug, answers: inputData.answers } };

    if (failedFlags.length) {
      baseOptions._regenerateHint = `Previous version was flagged for: ${failedFlags.join(', ')}. Avoid these patterns.`;
    }

    if (post.path === 'idea') {
      const ideaResult = await synthesiseIdeaWithOptionalQualityRetry(userProfile, baseOptions);
      const isInsightRow = post.format_slug === IDEA_INSIGHT_SLUG;
      const content = isInsightRow
        ? (ideaResult.alternative?.post ?? ideaResult.post)
        : ideaResult.post;
      const gate = isInsightRow
        ? (ideaResult.alternative?.gate ?? ideaResult.primaryGate)
        : ideaResult.primaryGate;

      db.prepare(`
        UPDATE generated_posts
        SET content = ?, quality_score = ?, quality_flags = ?, passed_gate = ?
        WHERE id = ?
      `).run(content, gate.score, JSON.stringify(gate.flags), gate.passed_gate ? 1 : 0, postId);

      const quality = buildQualityPayload(gate, ideaResult.synthesisAttempt, true);

      return res.json({
        ok: true,
        post: {
          id: Number(postId),
          format_slug: post.format_slug,
          content,
          quality_score: gate.score,
          quality_flags: gate.flags,
          passed_gate: gate.passed_gate,
          archetypeUsed: isInsightRow ? 'INSIGHT' : ideaResult.archetypeUsed,
          hookConfidence: isInsightRow ? null : ideaResult.hookConfidence,
          quality,
        },
      });
    }

    const {
      posts: rawPosts,
      archetypeUsed,
      hookConfidence,
      gated,
      synthesisAttempt,
    } = await synthesiseWithOptionalQualityRetry(userProfile, baseOptions, post.path);

    const newPost = rawPosts.find(p => p.format_slug === post.format_slug) || rawPosts[0];
    const gatedOne = gated.find(g => g.post.format_slug === post.format_slug) || gated[0];
    const gate = gatedOne.gate;

    db.prepare(`
      UPDATE generated_posts
      SET content = ?, quality_score = ?, quality_flags = ?, passed_gate = ?
      WHERE id = ?
    `).run(newPost.content, gate.score, JSON.stringify(gate.flags), gate.passed_gate ? 1 : 0, postId);

    const quality = buildQualityPayload(gate, synthesisAttempt, true);

    return res.json({
      ok: true,
      post: {
        id: Number(postId),
        format_slug: post.format_slug,
        content: newPost.content,
        quality_score: gate.score,
        quality_flags: gate.flags,
        passed_gate: gate.passed_gate,
        archetypeUsed,
        hookConfidence,
        quality,
      },
    });

  } catch (err) {
    console.error('[generate/regenerate] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/quality-check
// Re-scores post text after manual client-side edits. No generation.
// Body: { postText, archetypeUsed, hookConfidence }
// ---------------------------------------------------------------------------
router.post('/quality-check', (req, res) => {
  const userId = req.userId;
  const tenantId = req.tenantId;
  const { postText, archetypeUsed = null, hookConfidence = null } = req.body;

  if (!postText || typeof postText !== 'string') {
    return res.status(400).json({ ok: false, error: 'postText is required' });
  }

  const userProfile = userId
    ? db.prepare('SELECT * FROM user_profiles WHERE user_id = ? AND tenant_id = ?').get(userId, tenantId)
    : null;

  const quality = runQualityGate(postText, {
    archetypeUsed: archetypeUsed ?? null,
    hookConfidence: typeof hookConfidence === 'number' ? hookConfidence : null,
    voiceProfile: userProfile || {},
    path: 'idea',
  });

  return res.json({ ok: true, quality });
});

module.exports = router;

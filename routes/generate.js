'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { synthesise } = require('../services/synthesise');
const { runQualityGate } = require('../services/qualityGate');
const { generateInsightAlternativePost, vaultSeedToPost } = require('../services/ideaPath');
const { classifyContent } = require('../services/funnelClassifier');
const { canGeneratePost } = require('../services/subscription');
const { sendEmailToUser } = require('../emails');

// ---------------------------------------------------------------------------
// Sliding window rate limiter — 10 generations per hour per user.
// Uses Redis when available (consistent across multiple instances); falls back
// to an in-process Map on single-server deployments without Redis.
// ---------------------------------------------------------------------------
const { getRedis } = require('../services/redis');
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const generationTimestamps = new Map(); // fallback: userId → number[]

async function checkRateLimit(userId) {
  const redis = getRedis();

  if (redis) {
    // Redis sliding window: store timestamps as a sorted set keyed by userId.
    const key    = `gen_ratelimit:${userId}`;
    const now    = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    try {
      const pipe = redis.pipeline();
      pipe.zremrangebyscore(key, '-inf', cutoff);          // evict old entries
      pipe.zadd(key, now, String(now));                    // add current timestamp
      pipe.zrange(key, 0, -1);                             // fetch all in window
      pipe.expire(key, Math.ceil(RATE_LIMIT_WINDOW_MS / 1000));
      const results = await pipe.exec();
      const members = results[2][1]; // zrange result
      if (members.length > RATE_LIMIT_MAX) {
        // Remove the entry we just added (don't count this attempt)
        await redis.zrem(key, String(now));
        const oldest = Number(members[0]);
        const retryAfterSec = Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000);
        return { limited: true, retryAfterSec };
      }
      return { limited: false };
    } catch {
      // Redis error — fall through to in-memory fallback
    }
  }

  // In-memory fallback
  const now    = Date.now();
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

const IDEA_SLUG = 'idea';
const IDEA_INSIGHT_SLUG = 'idea_insight';

/**
 * Idea path: single primary post + optional INSIGHT alternative after primary passes gate.
 */
async function synthesiseIdeaWithOptionalQualityRetry(userProfile, baseOptions) {
  let synthesisAttempt = 1;
  let synthResult = await synthesise(userProfile, baseOptions);
  let { synthesis, post, hookB, archetypeUsed, hookConfidence } = synthResult;

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
    ({ synthesis, post, hookB, archetypeUsed, hookConfidence } = synthResult);
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
    hookB: hookB || null,
    archetypeUsed,
    hookConfidence,
    primaryGate,
    alternative,
    synthesisAttempt,
  };
}

/**
 * Vault path: quality-gate loop around vaultSeedToPost.
 * No INSIGHT alternative — vault seeds have a pre-classified archetype.
 */
async function synthesiseVaultWithQualityRetry(userProfile, vaultIdea, chunkText, baseOptions) {
  let synthesisAttempt = 1;
  let synthResult = await vaultSeedToPost(vaultIdea, chunkText, userProfile, baseOptions);
  let { synthesis, post, hookB, archetypeUsed, hookConfidence } = synthResult;

  const gate = () =>
    runQualityGate(
      post,
      gateOptions({ format_slug: IDEA_SLUG, content: post }, userProfile, 'idea', archetypeUsed, hookConfidence)
    );

  let primaryGate = gate();

  if (!primaryGate.passed) {
    const qualityRetryHint =
      `The previous attempt failed these quality checks: ${primaryGate.errors.join(', ')}. Fix all of these in your next attempt.`;
    synthesisAttempt = 2;
    synthResult = await vaultSeedToPost(vaultIdea, chunkText, userProfile, { ...baseOptions, qualityRetryHint });
    ({ synthesis, post, hookB, archetypeUsed, hookConfidence } = synthResult);
    primaryGate = gate();
  }

  return { synthesis, post, hookB: hookB || null, archetypeUsed, hookConfidence, primaryGate, synthesisAttempt };
}

// ---------------------------------------------------------------------------
// POST /api/generate
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const userId = req.userId;
  const tenantId = req.tenantId;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const rl = await checkRateLimit(userId);
  if (rl.limited) {
    return res.status(429).json({ ok: false, error: 'rate_limit_exceeded', retry_after_sec: rl.retryAfterSec });
  }

  const planCheck = await canGeneratePost(userId);
  if (!planCheck.allowed) {
    // Send limit-reached email once per calendar month.
    const monthKey = `limit-reached:${new Date().toISOString().slice(0, 7)}`; // e.g. "2026-04"
    const now = new Date();
    const firstOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const resetsOn = firstOfNextMonth.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    sendEmailToUser(userId, tenantId, 'limit-reached', {
      resets_on: resetsOn,
      app_url: process.env.APP_URL || '',
    }, { dedupKey: monthKey, withinHours: 30 * 24 });
    return res.status(403).json({
      ok: false,
      error: 'plan_limit_exceeded',
      plan: planCheck.plan,
      current: planCheck.current,
      limit: planCheck.limit,
      upgrade_url: '/billing.html',
    });
  }

  const { path: genPath, raw_idea, vault_idea_id } = req.body;

  if (!genPath) return res.status(400).json({ ok: false, error: 'missing_path' });

  const userProfile = await db
    .prepare('SELECT * FROM user_profiles WHERE user_id = ? AND tenant_id = ?')
    .get(userId, tenantId);

  if (!userProfile) {
    return res.status(400).json({ ok: false, error: 'complete_profile_first' });
  }

  if (!raw_idea?.trim()) {
    return res.status(400).json({ ok: false, error: 'missing_raw_idea' });
  }

  // Resolve vault idea + source chunk when growing from a seed
  let vaultIdea = null;
  let vaultChunkText = null;
  if (vault_idea_id) {
    vaultIdea = await db.prepare(`
      SELECT id, seed_text, source_ref, funnel_type, hook_archetype, chunk_id
      FROM   vault_ideas
      WHERE  id = ? AND user_id = ? AND tenant_id = ?
    `).get(vault_idea_id, userId, tenantId);

    if (vaultIdea?.chunk_id) {
      const chunk = await db.prepare(
        'SELECT content FROM vault_chunks WHERE id = ? AND user_id = ? AND tenant_id = ?'
      ).get(vaultIdea.chunk_id, userId, tenantId);
      vaultChunkText = chunk?.content || null;
    }
  }

  try {
    let ideaResult;

    if (vaultIdea) {
      // Vault path — uses pre-classified archetype + source chunk context
      const funnelHints = {
        reach:   'This post should maximise reach — use a broad, relatable angle that resonates with a wide audience.',
        trust:   'This post should build authority — demonstrate expertise, share a proprietary framework, or offer a counterintuitive perspective.',
        convert: 'This post should drive inbound — be specific about who you help and what transformation you create. Include a subtle but clear call to action.',
      };
      const vaultOptions = vaultIdea.funnel_type
        ? { _funnelHint: funnelHints[vaultIdea.funnel_type] || '' }
        : {};
      ideaResult = await synthesiseVaultWithQualityRetry(userProfile, vaultIdea, vaultChunkText, vaultOptions);
    } else {
      // Standard idea path
      ideaResult = await synthesiseIdeaWithOptionalQualityRetry(userProfile, { rawIdea: raw_idea });
    }

    {
      const {
        synthesis,
        post,
        hookB,
        archetypeUsed,
        hookConfidence,
        primaryGate,
        alternative,
        synthesisAttempt,
      } = ideaResult;

      if (typeof post !== 'string' || !post.trim()) {
        throw new Error('generation returned no post content');
      }

      // For vault posts store seed_text as the canonical input so regenerate works correctly
      const inputData = vaultIdea
        ? { raw_idea: vaultIdea.seed_text, vault_idea_id: vaultIdea.id }
        : { raw_idea };

      const runResult = await db.prepare(`
        INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
        VALUES (?, ?, ?, ?, ?)
        RETURNING id
      `).run(
        userId,
        tenantId,
        genPath,
        JSON.stringify(inputData),
        JSON.stringify(synthesis)
      );
      const runId = runResult.lastInsertRowid;

      // Funnel type: honour the source vault idea's classification when available.
      // Reclassifying the generated post text causes drift (well-written posts
      // read as "trust" even when the seed idea was explicitly reach/convert).
      const funnelType = vaultIdea?.funnel_type || (await classifyContent(post)).funnelType;
      const vaultSourceRef = vaultIdea?.source_ref || null;

      const postsInsert = db.prepare(`
        INSERT INTO generated_posts
          (run_id, user_id, tenant_id, format_slug, content, quality_score, quality_flags, passed_gate, funnel_type, vault_source_ref, hook_b)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `);

      const primaryInsert = await postsInsert.run(
        runId,
        userId,
        tenantId,
        IDEA_SLUG,
        post,
        primaryGate.score,
        JSON.stringify(primaryGate.flags),
        primaryGate.passed_gate ? 1 : 0,
        funnelType,
        vaultSourceRef,
        hookB || null
      );
      const primaryId = primaryInsert.lastInsertRowid;

      // Link vault idea to this post and mark as used
      if (vaultIdea) {
        await db.prepare(`
          UPDATE vault_ideas SET status = 'used', generated_post_id = ? WHERE id = ?
        `).run(primaryId, vaultIdea.id);
      }

      const primaryQuality = buildQualityPayload(primaryGate, synthesisAttempt, true);

      let altPayload = null;
      if (alternative) {
        const altInsert = await postsInsert.run(
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
        hookB: hookB || null,
        id: primaryId,
        archetypeUsed,
        hookConfidence,
        quality: primaryQuality,
        alternative: altPayload == null ? null : altPayload,
        funnel_type: funnelType,
        vault_source_ref: vaultSourceRef,
      });
    }

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

  const rl = await checkRateLimit(userId);
  if (rl.limited) {
    return res.status(429).json({ ok: false, error: 'rate_limit_exceeded', retry_after_sec: rl.retryAfterSec });
  }

  const planCheck = await canGeneratePost(userId);
  if (!planCheck.allowed) {
    // Send limit-reached email once per calendar month.
    const monthKey = `limit-reached:${new Date().toISOString().slice(0, 7)}`;
    const now = new Date();
    const firstOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const resetsOn = firstOfNextMonth.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    sendEmailToUser(userId, tenantId, 'limit-reached', {
      resets_on: resetsOn,
      app_url: process.env.APP_URL || '',
    }, { dedupKey: monthKey, withinHours: 30 * 24 });
    return res.status(403).json({
      ok: false,
      error: 'plan_limit_exceeded',
      plan: planCheck.plan,
      current: planCheck.current,
      limit: planCheck.limit,
      upgrade_url: '/billing.html',
    });
  }

  const post = await db.prepare(`
    SELECT gp.*, gr.path, gr.input_data
    FROM generated_posts gp
    JOIN generation_runs gr ON gp.run_id = gr.id
    WHERE gp.id = ? AND gp.user_id = ? AND gp.tenant_id = ?
  `).get(postId, userId, tenantId);

  if (!post) return res.status(404).json({ ok: false, error: 'post_not_found' });
  if (post.status !== 'draft') {
    return res.status(409).json({ ok: false, error: 'post_not_editable', status: post.status });
  }

  const userProfile = await db
    .prepare('SELECT * FROM user_profiles WHERE user_id = ? AND tenant_id = ?')
    .get(userId, tenantId);

  if (!userProfile) return res.status(400).json({ ok: false, error: 'complete_profile_first' });

  try {
    const inputData = JSON.parse(post.input_data || '{}');
    const failedFlags = JSON.parse(post.quality_flags || '[]');
    const regenHint = failedFlags.length
      ? `Previous version was flagged for: ${failedFlags.join(', ')}. Avoid these patterns.`
      : undefined;

    let ideaResult;

    if (inputData.vault_idea_id) {
      // Re-grow from the original vault seed using the vault path
      const regenVaultIdea = await db.prepare(`
        SELECT id, seed_text, source_ref, funnel_type, hook_archetype, chunk_id
        FROM   vault_ideas
        WHERE  id = ? AND user_id = ? AND tenant_id = ?
      `).get(inputData.vault_idea_id, userId, tenantId);

      if (regenVaultIdea) {
        let regenChunkText = null;
        if (regenVaultIdea.chunk_id) {
          const chunk = await db.prepare(
            'SELECT content FROM vault_chunks WHERE id = ? AND user_id = ? AND tenant_id = ?'
          ).get(regenVaultIdea.chunk_id, userId, tenantId);
          regenChunkText = chunk?.content || null;
        }
        const vaultOpts = regenHint ? { _regenerateHint: regenHint } : {};
        ideaResult = await synthesiseVaultWithQualityRetry(userProfile, regenVaultIdea, regenChunkText, vaultOpts);
      }
    }

    if (!ideaResult) {
      // Standard idea path (free-typed ideas, or vault idea no longer exists)
      const baseOptions = { rawIdea: inputData.raw_idea };
      if (regenHint) baseOptions._regenerateHint = regenHint;
      ideaResult = await synthesiseIdeaWithOptionalQualityRetry(userProfile, baseOptions);
    }

    const isInsightRow = post.format_slug === IDEA_INSIGHT_SLUG;
    const content = isInsightRow
      ? (ideaResult.alternative?.post ?? ideaResult.post)
      : ideaResult.post;
    const gate = isInsightRow
      ? (ideaResult.alternative?.gate ?? ideaResult.primaryGate)
      : ideaResult.primaryGate;

    await db.prepare(`
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
router.post('/quality-check', async (req, res) => {
  const userId = req.userId;
  const tenantId = req.tenantId;
  const { postText, archetypeUsed = null, hookConfidence = null } = req.body;

  if (!postText || typeof postText !== 'string') {
    return res.status(400).json({ ok: false, error: 'postText is required' });
  }

  const userProfile = userId
    ? await db.prepare('SELECT * FROM user_profiles WHERE user_id = ? AND tenant_id = ?').get(userId, tenantId)
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

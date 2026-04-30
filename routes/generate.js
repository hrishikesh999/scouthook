'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { runQualityGate } = require('../services/qualityGate');
const { restructureToPost, generateWeeklyBatch } = require('../services/ideaPath');
const { getVaultContext } = require('../services/ghostwriterPromptBuilder');
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

function gateOptions(post, userProfile, genPath, archetypeUsed, hookConfidence, funnelType = null) {
  return {
    voiceProfile: userProfile,
    archetypeUsed: archetypeUsed ?? null,
    hookConfidence: hookConfidence ?? null,
    formatSlug: post.format_slug,
    path: genPath,
    funnelType: funnelType ?? null,
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

async function restructureWithQualityGate(userProfile, sourceText, funnelType) {
  const { synthesis, post, ctaAlternatives, archetypeUsed, hookConfidence, contentFeedback } =
    await restructureToPost(sourceText, userProfile);

  const primaryGate = runQualityGate(
    post,
    gateOptions(
      { format_slug: IDEA_SLUG, content: post },
      userProfile,
      'idea',
      archetypeUsed,
      hookConfidence,
      funnelType || null
    )
  );

  return { synthesis, post, ctaAlternatives, archetypeUsed, hookConfidence, primaryGate, contentFeedback };
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

    const sourceText = vaultIdea
      ? (vaultChunkText || vaultIdea.seed_text)
      : raw_idea;
    const funnelTypeForGate = vaultIdea?.funnel_type || null;
    ideaResult = await restructureWithQualityGate(userProfile, sourceText, funnelTypeForGate);

    {
      const {
        synthesis,
        post,
        ctaAlternatives,
        archetypeUsed,
        hookConfidence,
        primaryGate,
        contentFeedback,
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
          (run_id, user_id, tenant_id, format_slug, content, quality_score, quality_flags, passed_gate, funnel_type, vault_source_ref, hook_b, cta_alternatives, idea_input)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        null,
        ctaAlternatives?.length ? JSON.stringify(ctaAlternatives) : null,
        inputData.raw_idea || null
      );
      const primaryId = primaryInsert.lastInsertRowid;

      // Link vault idea to this post and mark as used
      if (vaultIdea) {
        await db.prepare(`
          UPDATE vault_ideas SET status = 'used', generated_post_id = ? WHERE id = ?
        `).run(primaryId, vaultIdea.id);
      }

      const primaryQuality = buildQualityPayload(primaryGate, 1, true);

      return res.json({
        ok: true,
        run_id: runId,
        synthesis,
        post,
        hookB: null,
        ctaAlternatives: ctaAlternatives || [],
        id: primaryId,
        archetypeUsed,
        hookConfidence,
        quality: primaryQuality,
        alternative: null,
        funnel_type: funnelType,
        vault_source_ref: vaultSourceRef,
        content_feedback: contentFeedback || null,
      });
    }

  } catch (err) {
    console.error('[generate] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/generate/weekly-batch
// Generates 5 Mon–Fri posts using the user's ghostwriter prompt + vault context.
// ---------------------------------------------------------------------------
router.post('/weekly-batch', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const rl = await checkRateLimit(userId);
  if (rl.limited) {
    return res.status(429).json({ ok: false, error: 'rate_limit_exceeded', retry_after_sec: rl.retryAfterSec });
  }

  const planCheck = await canGeneratePost(userId);
  if (!planCheck.allowed) {
    return res.status(403).json({
      ok: false, error: 'plan_limit_exceeded',
      plan: planCheck.plan, current: planCheck.current, limit: planCheck.limit,
      upgrade_url: '/billing.html',
    });
  }

  let userProfile = await db
    .prepare('SELECT * FROM user_profiles WHERE user_id = ? AND tenant_id = ?')
    .get(userId, tenantId);

  if (!userProfile) return res.status(400).json({ ok: false, error: 'complete_profile_first' });

  try {
  const vault = await getVaultContext(userId, tenantId);
  if (!vault?.text) {
    return res.status(400).json({ ok: false, error: 'no_vault_documents', message: 'Upload and index at least one document to generate posts from.' });
  }

  // Build (or rebuild) the ghostwriter prompt when missing or stale.
  // Stale = a vault document was added/updated after the prompt was last built.
  const latestDoc = await db
    .prepare(`SELECT MAX(updated_at) AS ts FROM vault_documents WHERE user_id = ? AND tenant_id = ? AND status = 'ready'`)
    .get(userId, tenantId);
  const promptBuiltAt = userProfile.ghostwriter_prompt_built_at;
  const latestDocAt   = latestDoc?.ts;
  const isStale = !userProfile.ghostwriter_prompt || (latestDocAt && promptBuiltAt && latestDocAt > promptBuiltAt);

  if (isStale) {
    const { buildGhostwriterPrompt } = require('../services/ghostwriterPromptBuilder');
    await buildGhostwriterPrompt(userId, tenantId);
    userProfile = await db
      .prepare('SELECT * FROM user_profiles WHERE user_id = ? AND tenant_id = ?')
      .get(userId, tenantId);
    if (!userProfile.ghostwriter_prompt) {
      return res.status(400).json({ ok: false, error: 'ghostwriter_prompt_not_ready', message: 'Could not build your AI profile. Make sure your Voice Profile (Content Niche + Audience) is filled in.' });
    }
  }

  try {
    const posts = await generateWeeklyBatch(userProfile.ghostwriter_prompt, vault.text);

    const batchId = require('crypto').randomUUID();

    // Create a generation_runs row for this batch (run_id is NOT NULL)
    const run = await db.prepare(`
      INSERT INTO generation_runs (user_id, tenant_id, path, input_data)
      VALUES (?, ?, 'ghostwriter_batch', ?)
      RETURNING id
    `).get(userId, tenantId, JSON.stringify({ batch_id: batchId }));
    const runId = run.id;

    const insertPost = db.prepare(`
      INSERT INTO generated_posts
        (run_id, user_id, tenant_id, format_slug, content, quality_score, quality_flags, passed_gate, funnel_type, cta_alternatives, idea_input, batch_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    const savedPosts = [];
    for (const p of posts) {
      const gate = runQualityGate(p.post, {
        voiceProfile:   userProfile,
        archetypeUsed:  null,
        hookConfidence: null,
        path:           'ghostwriter',
        funnelType:     'trust',
      });

      const inserted = await insertPost.run(
        userId, tenantId,
        `ghostwriter_${p.format.toLowerCase()}`,
        p.post,
        gate.score,
        JSON.stringify(gate.flags),
        gate.passed ? 1 : 0,
        'trust',
        p.ctaAlternatives?.length ? JSON.stringify(p.ctaAlternatives) : null,
        `${p.day} — ${p.format}`,
        batchId
      );

      savedPosts.push({
        id:              inserted.lastInsertRowid,
        day:             p.day,
        format:          p.format,
        post:            p.post,
        ctaAlternatives: p.ctaAlternatives,
        quality:         { passed: gate.passed, score: gate.score },
      });
    }

    return res.json({ ok: true, batch_id: batchId, posts: savedPosts });

  } catch (err) {
    console.error('[generate/weekly-batch] inner error:', err.message);
    return res.status(500).json({ ok: false, error: err.message, message: err.message });
  }

  } catch (err) {
    console.error('[generate/weekly-batch] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message, message: err.message });
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
        const regenSource = regenChunkText || regenVaultIdea.seed_text;
        ideaResult = await restructureWithQualityGate(userProfile, regenSource, regenVaultIdea.funnel_type || null);
      }
    }

    if (!ideaResult) {
      // Standard idea path (free-typed ideas, or vault idea no longer exists)
      ideaResult = await restructureWithQualityGate(userProfile, inputData.raw_idea, null);
    }

    const isInsightRow = post.format_slug === IDEA_INSIGHT_SLUG;
    const content = isInsightRow
      ? (ideaResult.alternative?.post ?? ideaResult.post)
      : ideaResult.post;
    const gate = isInsightRow
      ? (ideaResult.alternative?.gate ?? ideaResult.primaryGate)
      : ideaResult.primaryGate;

    const regenCtaAlternatives = isInsightRow ? [] : (ideaResult.ctaAlternatives || []);

    await db.prepare(`
      UPDATE generated_posts
      SET content = ?, quality_score = ?, quality_flags = ?, passed_gate = ?, cta_alternatives = ?
      WHERE id = ?
    `).run(content, gate.score, JSON.stringify(gate.flags), gate.passed_gate ? 1 : 0,
      regenCtaAlternatives.length ? JSON.stringify(regenCtaAlternatives) : null, postId);

    const quality = buildQualityPayload(gate, 1, true);

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
        ctaAlternatives: regenCtaAlternatives,
        quality,
      },
    });

  } catch (err) {
    console.error('[generate/regenerate] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/generate/post/:postId
// Loads a single generated post for the preview page.
// ---------------------------------------------------------------------------
router.get('/post/:postId', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  const { postId } = req.params;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const row = await db.prepare(`
    SELECT id, content, quality_score, quality_flags, passed_gate,
           hook_b, cta_alternatives, format_slug, funnel_type
    FROM generated_posts
    WHERE id = ? AND user_id = ? AND tenant_id = ?
  `).get(postId, userId, tenantId);

  if (!row) return res.status(404).json({ ok: false, error: 'post_not_found' });

  let flags = [];
  try { flags = JSON.parse(row.quality_flags || '[]'); } catch {}
  let ctaAlternatives = [];
  try { ctaAlternatives = JSON.parse(row.cta_alternatives || '[]'); } catch {}

  return res.json({
    ok: true,
    post: {
      id:              row.id,
      content:         row.content,
      quality:         { score: row.quality_score || 0, passed: row.passed_gate === 1, flags, errors: flags, warnings: [] },
      hookB:           row.hook_b || null,
      ctaAlternatives,
      archetype:       null,
      funnelType:      row.funnel_type || null,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/generate/batch/:batch_id
// Loads all posts in a weekly batch for the preview page.
// ---------------------------------------------------------------------------
router.get('/batch/:batch_id', async (req, res) => {
  const userId   = req.userId;
  const tenantId = req.tenantId;
  const { batch_id } = req.params;

  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const rows = await db.prepare(`
    SELECT id, format_slug, content, quality_score, quality_flags, passed_gate,
           cta_alternatives, hook_b, idea_input
    FROM generated_posts
    WHERE batch_id = ? AND user_id = ? AND tenant_id = ?
    ORDER BY id ASC
  `).all(batch_id, userId, tenantId);

  if (!rows.length) return res.status(404).json({ ok: false, error: 'batch_not_found' });

  const posts = rows.map(row => {
    let flags = [];
    try { flags = JSON.parse(row.quality_flags || '[]'); } catch {}
    let ctaAlternatives = [];
    try { ctaAlternatives = JSON.parse(row.cta_alternatives || '[]'); } catch {}
    const parts  = (row.idea_input || '').split(' — ');
    const day    = parts[0] || '';
    const format = (row.format_slug || '').replace(/^ghostwriter_/, '');
    return {
      id:              row.id,
      day,
      format,
      post:            row.content,
      quality:         { score: row.quality_score || 0, passed: row.passed_gate === 1, flags, errors: flags, warnings: [] },
      hookB:           row.hook_b || null,
      ctaAlternatives,
    };
  });

  return res.json({ ok: true, batch_id, posts });
});

// ---------------------------------------------------------------------------
// POST /api/quality-check
// Re-scores post text after manual client-side edits. No generation.
// Body: { postText, archetypeUsed, hookConfidence }
// ---------------------------------------------------------------------------
router.post('/quality-check', async (req, res) => {
  const userId = req.userId;
  const tenantId = req.tenantId;
  const { postText, archetypeUsed = null, hookConfidence = null, funnel_type = null } = req.body;

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
    funnelType: funnel_type ?? null,
  });

  return res.json({ ok: true, quality });
});

module.exports = router;

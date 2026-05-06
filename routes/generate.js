'use strict';

const express = require('express');
const router = express.Router();
const { db, getSetting } = require('../db');
const { runQualityGate } = require('../services/qualityGate');
const { ideaToPost, restructureToPost } = require('../services/ideaPath');
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

async function restructureWithQualityGate(userProfile, sourceText, funnelType, options = {}) {
  const { synthesis, post, ctaAlternatives, archetypeUsed, hookConfidence, contentFeedback } =
    await restructureToPost(sourceText, userProfile, null, options);

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

  const { path: genPath, raw_idea, vault_idea_id, skip_substance_check } = req.body;

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
    ideaResult = await restructureWithQualityGate(userProfile, sourceText, funnelTypeForGate, {
      skipSubstanceCheck: !!skip_substance_check,
    });

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
          (run_id, user_id, tenant_id, format_slug, content, quality_score, quality_flags, passed_gate, funnel_type, vault_source_ref, hook_b, cta_alternatives, idea_input, archetype_used)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        inputData.raw_idea || null,
        archetypeUsed || null
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
    if (err.message === 'missing_substance') {
      return res.status(422).json({ ok: false, error: 'missing_substance', prompt: err.substancePrompt });
    }
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

    const regenArchetype = isInsightRow ? 'INSIGHT' : (ideaResult.archetypeUsed || null);
    await db.prepare(`
      UPDATE generated_posts
      SET content = ?, quality_score = ?, quality_flags = ?, passed_gate = ?, cta_alternatives = ?, archetype_used = ?
      WHERE id = ?
    `).run(content, gate.score, JSON.stringify(gate.flags), gate.passed_gate ? 1 : 0,
      regenCtaAlternatives.length ? JSON.stringify(regenCtaAlternatives) : null, regenArchetype, postId);

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

  let row;
  try {
    row = await db.prepare(`
      SELECT id, content, quality_score, quality_flags, passed_gate,
             hook_b, cta_alternatives, format_slug, funnel_type,
             asset_url, asset_preview_url, asset_type, asset_slide_count, first_comment
      FROM generated_posts
      WHERE id = ? AND user_id = ? AND tenant_id = ?
    `).get(postId, userId, tenantId);
  } catch {
    row = await db.prepare(`
      SELECT id, content, quality_score, quality_flags, passed_gate,
             hook_b, cta_alternatives, format_slug, funnel_type
      FROM generated_posts
      WHERE id = ? AND user_id = ? AND tenant_id = ?
    `).get(postId, userId, tenantId);
  }

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
      assetUrl:        row.asset_url        || null,
      assetPreviewUrl: row.asset_preview_url || null,
      assetType:       row.asset_type        || null,
      assetSlideCount: row.asset_slide_count || 0,
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
// POST /api/generate/from-doc
// Extracts a key insight from an uploaded document (or URL) and generates a post.
// File: raw binary body + Content-Type header + X-Filename header (URI-encoded)
// URL:  Content-Type: application/json + { url }
// ---------------------------------------------------------------------------
const FROM_DOC_MIME_MAP = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
};

router.post('/from-doc', async (req, res) => {
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

  const contentType = (req.headers['content-type'] || '').split(';')[0].trim();

  let docText        = '';
  let filename       = 'document';
  let fileBuffer     = null;
  let fileSourceType = null;
  let sourceUrl      = null;

  let skipSubstanceCheckDoc = false;
  if (contentType === 'application/json') {
    const body = req.body || {};
    const { url, vault_doc_id } = body;
    skipSubstanceCheckDoc = !!body.skip_substance_check;

    if (vault_doc_id) {
      // Use an already-indexed vault document — fetch its chunks from the database
      const doc = await db
        .prepare(`SELECT id, filename FROM vault_documents WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'ready'`)
        .get(vault_doc_id, userId, tenantId);
      if (!doc) {
        return res.status(404).json({ ok: false, error: 'vault_doc_not_found' });
      }
      filename = doc.filename;
      const chunks = await db
        .prepare(`SELECT content FROM vault_chunks WHERE document_id = ? AND user_id = ? ORDER BY chunk_index`)
        .all(vault_doc_id, userId);
      docText = chunks.map(c => c.content).join('\n\n');
    } else {
      if (!url || !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ ok: false, error: 'invalid_url' });
      }
      sourceUrl = url;
      try { filename = new URL(url).hostname; } catch { filename = 'url-doc'; }

      const { extractUrl } = require('../services/vaultMiner');
      try {
        const { text } = await extractUrl(url);
        docText = text;
      } catch (err) {
        return res.status(400).json({ ok: false, error: 'url_fetch_failed', detail: err.message });
      }
    }
  } else {
    // File upload — read raw binary body
    await new Promise((resolve, reject) => {
      express.raw({ type: '*/*', limit: '26mb' })(req, res, err => err ? reject(err) : resolve());
    });

    fileSourceType = FROM_DOC_MIME_MAP[contentType];
    if (!fileSourceType) {
      return res.status(415).json({ ok: false, error: 'unsupported_file_type', allowed: ['pdf', 'docx', 'txt'] });
    }
    filename = (() => {
      try { return decodeURIComponent(req.headers['x-filename'] || ''); } catch { return ''; }
    })() || 'document';

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ ok: false, error: 'empty_body' });
    }
    if (req.body.length > 25 * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: 'file_too_large', max_mb: 25 });
    }

    fileBuffer = req.body;
    const { extractText } = require('../services/vaultMiner');
    try {
      const { text } = await extractText(fileBuffer, fileSourceType, filename);
      docText = text;
    } catch (err) {
      return res.status(400).json({ ok: false, error: 'extraction_failed', detail: err.message });
    }
  }

  if (!docText || docText.trim().length < 50) {
    return res.status(400).json({ ok: false, error: 'doc_too_short' });
  }

  const truncated = docText.slice(0, 4000);

  const userProfile = await db
    .prepare('SELECT * FROM user_profiles WHERE user_id = ? AND tenant_id = ?')
    .get(userId, tenantId);
  if (!userProfile) return res.status(400).json({ ok: false, error: 'complete_profile_first' });

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) return res.status(500).json({ ok: false, error: 'no_api_key' });

  try {
    const { synthesis, post, hookB, ctaAlternatives, archetypeUsed, hookConfidence } =
      await ideaToPost(truncated, userProfile, { skipSubstanceCheck: skipSubstanceCheckDoc });

    const primaryGate = runQualityGate(
      post,
      gateOptions(
        { format_slug: IDEA_SLUG, content: post },
        userProfile,
        'doc',
        archetypeUsed,
        hookConfidence,
        null
      )
    );

    const runResult = await db.prepare(`
      INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id
    `).run(
      userId, tenantId, 'doc',
      JSON.stringify({ raw_idea: truncated, doc_filename: filename }),
      JSON.stringify(synthesis)
    );
    const runId = runResult.lastInsertRowid;

    const funnelType = (await classifyContent(post)).funnelType;

    const primaryInsert = await db.prepare(`
      INSERT INTO generated_posts
        (run_id, user_id, tenant_id, format_slug, content, quality_score, quality_flags, passed_gate, funnel_type, hook_b, cta_alternatives, idea_input, archetype_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).run(
      runId, userId, tenantId, IDEA_SLUG,
      post, primaryGate.score, JSON.stringify(primaryGate.flags), primaryGate.passed_gate ? 1 : 0,
      funnelType, hookB || null,
      ctaAlternatives?.length ? JSON.stringify(ctaAlternatives) : null,
      truncated,
      archetypeUsed || null
    );
    const primaryId = primaryInsert.lastInsertRowid;

    await saveDocToVaultAsync({
      userId, tenantId, filename,
      buffer: fileBuffer, sourceType: fileSourceType, sourceUrl, docText,
    });

    const primaryQuality = buildQualityPayload(primaryGate, 1, true);

    return res.json({
      ok: true,
      run_id:          runId,
      synthesis,
      post,
      hookB:           hookB || null,
      ctaAlternatives: ctaAlternatives || [],
      id:              primaryId,
      archetypeUsed,
      hookConfidence,
      quality:         primaryQuality,
      alternative:     null,
      funnel_type:     funnelType,
      vault_source_ref: null,
      content_feedback: null,
      from_doc:        true,
    });

  } catch (err) {
    if (err.message === 'missing_substance') {
      return res.status(422).json({ ok: false, error: 'missing_substance', prompt: err.substancePrompt });
    }
    console.error('[generate/from-doc] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

async function saveDocToVaultAsync({ userId, tenantId, filename, buffer, sourceType, sourceUrl, docText }) {
  try {
    const { canUploadVaultDoc } = require('../services/subscription');
    const planCheck = await canUploadVaultDoc(userId);
    if (!planCheck.allowed) return; // silently skip if over vault limit

    const { chunkText } = require('../services/vaultMiner');
    const chunks = chunkText(docText, null);
    if (!chunks || chunks.length === 0) return;

    const docResult = await db.prepare(`
      INSERT INTO vault_documents (user_id, tenant_id, filename, source_type, source_url, status)
      VALUES (?, ?, ?, ?, ?, 'indexing')
      RETURNING id
    `).run(userId, tenantId, filename.slice(0, 200), sourceUrl ? 'url' : sourceType, sourceUrl || null);
    const docId = docResult.lastInsertRowid;

    const insertChunk = db.prepare(`
      INSERT INTO vault_chunks (document_id, user_id, tenant_id, chunk_index, content, source_ref)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const chunk of chunks) {
      await insertChunk.run(docId, userId, tenantId, chunk.chunkIndex, chunk.content, chunk.sourceRef);
    }
    await db.prepare(`
      UPDATE vault_documents SET status = 'ready', chunk_count = ?, updated_at = now() WHERE id = ?
    `).run(chunks.length, docId);

    console.log(`[generate/from-doc] vault doc=${docId} saved with ${chunks.length} chunks`);
  } catch (err) {
    console.error('[generate/from-doc] vault save failed (non-fatal):', err.message);
  }
}

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

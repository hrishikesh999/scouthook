'use strict';

const express = require('express');
const router = express.Router();
const { db, getSetting } = require('../db');
const { runQualityGate } = require('../services/qualityGate');
const { ideaToPost, vaultSeedToPost } = require('../services/ideaPath');
const { generateAuthorityPost } = require('../services/authorityExpertisePath');
const { generateStoryPost }     = require('../services/storyPersonalExperiencePath');
const { generateBtsPost }          = require('../services/behindTheScenesPath');
const { generateContrarianPost }   = require('../services/contrarianHotTakePath');
const { generateFrameworkPost }    = require('../services/frameworkHowToPath');
const { generateAnnouncementPost } = require('../services/announcementPath');
const { generateLeadGenPost }      = require('../services/leadGenOfferPath');
const { generateLessonsLearnedPost } = require('../services/lessonsLearnedPath');
const { generatePisPost }            = require('../services/problemInsightSolutionPath');
const { classifyContent } = require('../services/funnelClassifier');
const { canGeneratePost } = require('../services/subscription');
const { sendEmailToUser } = require('../emails');
const { resolveProfile } = require('../lib/resolveProfile');
const { planHasFeature } = require('../lib/planFeatures');

// ---------------------------------------------------------------------------
// Sliding window rate limiter — 10 generations per hour per user.
// Uses Redis when available (consistent across multiple instances); falls back
// to an in-process Map on single-server deployments without Redis.
// ---------------------------------------------------------------------------
const { getRedis } = require('../services/redis');
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const generationTimestamps = new Map(); // fallback: userId → number[]

async function checkRateLimit(tenantId) {
  const redis = getRedis();

  if (redis) {
    // Redis sliding window: store timestamps as a sorted set keyed by workspace.
    const key    = `gen_ratelimit:${tenantId}`;
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
  const timestamps = (generationTimestamps.get(tenantId) || []).filter(t => t > cutoff);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    const retryAfterSec = Math.ceil((timestamps[0] - cutoff) / 1000);
    return { limited: true, retryAfterSec };
  }
  timestamps.push(now);
  generationTimestamps.set(tenantId, timestamps);
  return { limited: false };
}

function gateOptions(post, profile, genPath, archetypeUsed, funnelType = null) {
  return {
    voiceProfile:  profile,
    archetypeUsed: archetypeUsed ?? null,
    formatSlug:    post.format_slug,
    path:          genPath,
    funnelType:    funnelType ?? null,
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
    dimensions: gate.dimensions ?? null,
  };
  if (isPrimary && !gate.passed && synthesisAttempt === 2) {
    quality.forcedReturn = true;
  }
  return quality;
}

const IDEA_SLUG = 'idea';
const IDEA_INSIGHT_SLUG = 'idea_insight';

function assembleExtractionInputs(postType, answers, tensionStatement) {
  const parts = [];
  if (tensionStatement) parts.push(`CENTRAL TENSION: ${tensionStatement}`);
  if (postType === 'reach') {
    if (answers.moment)  parts.push(`WHAT HAPPENED: ${answers.moment}`);
    if (answers.lesson)  parts.push(`WHAT TO DO: ${answers.lesson}`);
    if (answers.angle)   parts.push(`WHAT MOST PEOPLE GET WRONG: ${answers.angle}`);
  } else if (postType === 'trust') {
    if (answers.contrarian) parts.push(`THE BELIEF: ${answers.contrarian}`);
    if (answers.proof)      parts.push(`THE PROOF: ${answers.proof}`);
    if (answers.audience)   parts.push(`WHO THIS IS FOR: ${answers.audience}`);
  } else if (postType === 'convert') {
    if (answers.result)    parts.push(`THE RESULT: ${answers.result}`);
    if (answers.mechanism) parts.push(`WHAT DROVE IT: ${answers.mechanism}`);
    if (answers.target)    parts.push(`WHO SHOULD ACT: ${answers.target}`);
  }
  return parts.join('\n\n');
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
    const monthKey = `limit-reached:${new Date().toISOString().slice(0, 7)}`;
    sendEmailToUser(userId, 'limit-reached', {
      resets_on: new Date(planCheck.resets_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
      app_url: process.env.APP_URL || '',
    }, { dedupKey: monthKey, withinHours: 30 * 24 });
    return res.status(429).json({
      ok: false,
      error: 'monthly_quota_reached',
      plan: planCheck.plan,
      used: planCheck.current,
      limit: planCheck.limit,
      resets_at: planCheck.resets_at,
      upgrade_url: '/billing.html',
    });
  }

  // Carousel requires Pro plan
  if (req.body?.asset_type === 'carousel' && !planHasFeature(planCheck.plan, 'carousel')) {
    return res.status(403).json({ ok: false, error: 'feature_not_available', feature: 'carousel', requiredPlan: 'pro' });
  }

  const { path: genPath, vault_idea_id, skip_substance_check, interview_answers, funnel_type: bodyFunnelType,
          archetype_override, source, post_type, convert_cta_intent,
          tension_statement, length_preference, cta_intent } = req.body;
  let { raw_idea } = req.body;

  // Interview path: format Q&A answers into a structured raw_idea string.
  // Flag is passed to Stage 1 so Haiku knows to synthesise across answers,
  // not treat the first question line as a hook seed.
  let isInterviewPath = false;
  if (!raw_idea?.trim() && Array.isArray(interview_answers) && interview_answers.length) {
    raw_idea = interview_answers
      .filter(a => a.answer?.trim())
      .map(a => `${a.question}\n${a.answer.trim()}`)
      .join('\n\n');
    isInterviewPath = true;
  }

  if (!genPath) return res.status(400).json({ ok: false, error: 'missing_path' });

  let profile;
  try {
    profile = await resolveProfile(tenantId, req.body.profileId);
  } catch (err) {
    console.error('[generate] resolveProfile error:', err);
    return res.status(500).json({ ok: false, error: 'profile_load_failed', detail: err.message });
  }

  if (!profile) {
    return res.status(400).json({ ok: false, error: 'complete_profile_first' });
  }

  // First onboarding post: Voice DNA extraction fires as fire-and-forget from
  // the profile save, but the Sonnet call takes 5-15s and generation reads the
  // profile almost immediately after — so the first post always had an empty
  // voice fingerprint. Fix: run a fast Haiku extraction inline here (~2s) so
  // generation always has tone, voice anchors, and authority statements.
  // The background Sonnet extraction (already running) will overwrite this with
  // higher-quality results ~10s later, improving all subsequent posts.
  if (source === 'onboarding' &&
      !profile.voice_fingerprint &&
      (profile.onboarding_q2 || profile.onboarding_q3)) {
    try {
      const { extractVoiceDNAFromQA } = require('../services/voiceExtraction');
      await extractVoiceDNAFromQA(profile.id, { fast: true });
      profile = await resolveProfile(tenantId, req.body.profileId) || profile;
    } catch (err) {
      console.warn('[generate] Inline voice DNA extraction failed (non-fatal):', err.message);
    }
  }

  // Lazy seed: populate phrase library on first generation if writing samples exist but phrases haven't been extracted yet
  if (!profile.writing_sample_phrases && profile.writing_samples?.length >= 100) {
    try {
      const { seedPhrasesFromWritingSamples } = require('../services/writingSampleSeeder');
      const phrases = await seedPhrasesFromWritingSamples(userId, tenantId, profile.writing_samples);
      if (phrases.length) {
        await db.prepare('UPDATE profiles SET writing_sample_phrases = ? WHERE id = ?')
          .run(JSON.stringify(phrases), profile.id);
        profile.writing_sample_phrases = JSON.stringify(phrases);
      }
    } catch (err) {
      console.warn('[generate] Phrase seeding failed (non-fatal):', err.message);
    }
  }

  if (!raw_idea?.trim()) {
    return res.status(400).json({ ok: false, error: 'missing_raw_idea' });
  }

  // Resolve vault idea + source chunk (+ neighboring chunks) when growing from a seed
  let vaultIdea          = null;
  let vaultChunkText     = null;
  let vaultNeighborContext = null;
  if (vault_idea_id) {
    vaultIdea = await db.prepare(`
      SELECT id, seed_text, source_ref, funnel_type, hook_archetype, chunk_id
      FROM   vault_ideas
      WHERE  id = ? AND tenant_id = ?
    `).get(vault_idea_id, tenantId);

    if (vaultIdea?.chunk_id) {
      const chunk = await db.prepare(
        'SELECT content, chunk_index, document_id FROM vault_chunks WHERE id = ? AND tenant_id = ?'
      ).get(vaultIdea.chunk_id, tenantId);
      if (chunk) {
        vaultChunkText = chunk.content || null;
        // Fetch immediately adjacent chunks for surrounding context
        const neighbors = await db.prepare(`
          SELECT content FROM vault_chunks
          WHERE  document_id = ? AND tenant_id = ?
            AND  chunk_index IN (?, ?)
          ORDER  BY chunk_index
        `).all(chunk.document_id, tenantId,
               chunk.chunk_index - 1, chunk.chunk_index + 1);
        if (neighbors.length) {
          vaultNeighborContext = neighbors.map(n => n.content).join('\n\n---\n\n');
        }
      }
    }
  }

  try {
    // ── Standard path (Reach / Trust / Convert / free-write) ────────────────
    let ideaResult;

    if (!raw_idea?.trim()) {
      return res.status(400).json({ ok: false, error: 'missing_raw_idea' });
    }

    const funnelTypeForGate = vaultIdea?.funnel_type || post_type || bodyFunnelType || null;

    // ── SSE streaming path ────────────────────────────────────────────────────
    // Only for the standard idea path (not vault path).
    if (req.body.streaming && !vaultIdea) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const sseWrite = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        // ── Authority/Expertise path (trust post type) ─────────────────────
        if (post_type === 'trust') {
          sseWrite('step', { step: 'analyzing', label: 'Crafting your post...' });

          const authorityResult = await generateAuthorityPost(raw_idea, profile, {
            lengthPreference: length_preference || 'Medium',
            ctaIntent:        cta_intent || '',
          });

          sseWrite('step', { step: 'saving', label: 'Final quality check...' });

          const primaryGate = runQualityGate(authorityResult.post, {
            ...gateOptions(
              { format_slug: IDEA_SLUG, content: authorityResult.post },
              profile, 'idea', null, 'trust'
            ),
            postType: 'trust',
          });

          const runResult = await db.prepare(`
            INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
            VALUES (?, ?, ?, ?, ?)
            RETURNING id
          `).run(userId, tenantId, genPath, JSON.stringify({ raw_idea }), JSON.stringify(authorityResult.synthesis));
          const runId = runResult.lastInsertRowid;

          const primaryInsert = await db.prepare(`
            INSERT INTO generated_posts
              (run_id, user_id, tenant_id, profile_id, format_slug, content, ai_content, quality_score, quality_flags, passed_gate,
               funnel_type, vault_source_ref, idea_input, archetype_used, source,
               post_type, quality_verdict)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
          `).run(
            runId, userId, tenantId, profile.id, IDEA_SLUG,
            authorityResult.post, authorityResult.post,
            primaryGate.score, JSON.stringify(primaryGate.flags), primaryGate.passed_gate ? 1 : 0,
            'trust', null,
            raw_idea || null,
            null,
            source || null,
            'trust',
            primaryGate.verdict || null
          );
          const primaryId = primaryInsert.lastInsertRowid;

          const primaryQuality = buildQualityPayload(primaryGate, 1, true);

          sseWrite('done', {
            post_id:          primaryId,
            run_id:           runId,
            post:             authorityResult.post,
            quality:          { ...primaryQuality, verdict: primaryGate.verdict },
            archetypeUsed:    null,
            funnel_type:      'trust',
            post_type:        'trust',
            stage1Blueprint:  null,
            content_feedback: null,
          });
          return res.end();
        }

        // ── Story / Personal Experience path ──────────────────────────────
        if (post_type === 'story') {
          sseWrite('step', { step: 'analyzing', label: 'Crafting your story...' });

          const storyResult = await generateStoryPost(raw_idea, profile, {
            lengthPreference: length_preference || 'Medium',
            ctaIntent:        cta_intent || '',
          });

          sseWrite('step', { step: 'saving', label: 'Final quality check...' });

          const storyGate = runQualityGate(storyResult.post, {
            ...gateOptions(
              { format_slug: IDEA_SLUG, content: storyResult.post },
              profile, 'idea', null, 'story'
            ),
            postType: 'story',
          });

          const storyRunResult = await db.prepare(`
            INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
            VALUES (?, ?, ?, ?, ?)
            RETURNING id
          `).run(userId, tenantId, genPath, JSON.stringify({ raw_idea }), JSON.stringify(storyResult.synthesis));
          const storyRunId = storyRunResult.lastInsertRowid;

          const storyInsert = await db.prepare(`
            INSERT INTO generated_posts
              (run_id, user_id, tenant_id, profile_id, format_slug, content, ai_content, quality_score, quality_flags, passed_gate,
               funnel_type, vault_source_ref, idea_input, archetype_used, source,
               post_type, quality_verdict)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
          `).run(
            storyRunId, userId, tenantId, profile.id, IDEA_SLUG,
            storyResult.post, storyResult.post,
            storyGate.score, JSON.stringify(storyGate.flags), storyGate.passed_gate ? 1 : 0,
            'story', null,
            raw_idea || null, null, source || null,
            'story', storyGate.verdict || null
          );
          const storyId = storyInsert.lastInsertRowid;

          const storyQuality = buildQualityPayload(storyGate, 1, true);

          sseWrite('done', {
            post_id:          storyId,
            run_id:           storyRunId,
            post:             storyResult.post,
            quality:          { ...storyQuality, verdict: storyGate.verdict },
            archetypeUsed:    null,
            funnel_type:      'story',
            post_type:        'story',
            stage1Blueprint:  null,
            content_feedback: null,
          });
          return res.end();
        }

        // ── Lessons Learned path ──────────────────────────────────────────
        if (post_type === 'lessons_learned') {
          sseWrite('step', { step: 'analyzing', label: 'Crafting your lessons learned post...' });

          const lessonsResult = await generateLessonsLearnedPost(raw_idea, profile, {
            lengthPreference: length_preference || 'Medium',
            ctaIntent:        cta_intent || '',
          });

          sseWrite('step', { step: 'saving', label: 'Final quality check...' });

          const lessonsGate = runQualityGate(lessonsResult.post, {
            ...gateOptions(
              { format_slug: IDEA_SLUG, content: lessonsResult.post },
              profile, 'idea', null, 'lessons_learned'
            ),
            postType: 'lessons_learned',
          });

          const lessonsRunResult = await db.prepare(`
            INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
            VALUES (?, ?, ?, ?, ?)
            RETURNING id
          `).run(userId, tenantId, genPath, JSON.stringify({ raw_idea }), JSON.stringify(lessonsResult.synthesis));
          const lessonsRunId = lessonsRunResult.lastInsertRowid;

          const lessonsInsert = await db.prepare(`
            INSERT INTO generated_posts
              (run_id, user_id, tenant_id, profile_id, format_slug, content, ai_content, quality_score, quality_flags, passed_gate,
               funnel_type, vault_source_ref, idea_input, archetype_used, source,
               post_type, quality_verdict)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
          `).run(
            lessonsRunId, userId, tenantId, profile.id, IDEA_SLUG,
            lessonsResult.post, lessonsResult.post,
            lessonsGate.score, JSON.stringify(lessonsGate.flags), lessonsGate.passed_gate ? 1 : 0,
            'lessons_learned', null,
            raw_idea || null, null, source || null,
            'lessons_learned', lessonsGate.verdict || null
          );
          const lessonsId = lessonsInsert.lastInsertRowid;

          const lessonsQuality = buildQualityPayload(lessonsGate, 1, true);

          sseWrite('done', {
            post_id:          lessonsId,
            run_id:           lessonsRunId,
            post:             lessonsResult.post,
            quality:          { ...lessonsQuality, verdict: lessonsGate.verdict },
            archetypeUsed:    null,
            funnel_type:      'lessons_learned',
            post_type:        'lessons_learned',
            stage1Blueprint:  null,
            content_feedback: null,
          });
          return res.end();
        }

        // ── Behind-the-Scenes path ────────────────────────────────────────
        if (post_type === 'bts') {
          sseWrite('step', { step: 'analyzing', label: 'Crafting your BTS post...' });

          const btsResult = await generateBtsPost(raw_idea, profile, {
            lengthPreference: length_preference || 'Medium',
            ctaIntent:        cta_intent || '',
          });

          sseWrite('step', { step: 'saving', label: 'Final quality check...' });

          const btsGate = runQualityGate(btsResult.post, {
            ...gateOptions(
              { format_slug: IDEA_SLUG, content: btsResult.post },
              profile, 'idea', null, 'bts'
            ),
            postType: 'bts',
          });

          const btsRunResult = await db.prepare(`
            INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
            VALUES (?, ?, ?, ?, ?)
            RETURNING id
          `).run(userId, tenantId, genPath, JSON.stringify({ raw_idea }), JSON.stringify(btsResult.synthesis));
          const btsRunId = btsRunResult.lastInsertRowid;

          const btsInsert = await db.prepare(`
            INSERT INTO generated_posts
              (run_id, user_id, tenant_id, profile_id, format_slug, content, ai_content, quality_score, quality_flags, passed_gate,
               funnel_type, vault_source_ref, idea_input, archetype_used, source,
               post_type, quality_verdict)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
          `).run(
            btsRunId, userId, tenantId, profile.id, IDEA_SLUG,
            btsResult.post, btsResult.post,
            btsGate.score, JSON.stringify(btsGate.flags), btsGate.passed_gate ? 1 : 0,
            'bts', null,
            raw_idea || null, null, source || null,
            'bts', btsGate.verdict || null
          );
          const btsId = btsInsert.lastInsertRowid;

          const btsQuality = buildQualityPayload(btsGate, 1, true);

          sseWrite('done', {
            post_id:          btsId,
            run_id:           btsRunId,
            post:             btsResult.post,
            quality:          { ...btsQuality, verdict: btsGate.verdict },
            archetypeUsed:    null,
            funnel_type:      'bts',
            post_type:        'bts',
            stage1Blueprint:  null,
            content_feedback: null,
          });
          return res.end();
        }

        // ── Contrarian / Hot Take path ────────────────────────────────────
        if (post_type === 'contrarian') {
          sseWrite('step', { step: 'analyzing', label: 'Crafting your hot take...' });

          const contrarianResult = await generateContrarianPost(raw_idea, profile, {
            lengthPreference: length_preference || 'Medium',
          });

          sseWrite('step', { step: 'saving', label: 'Final quality check...' });

          const contrarianGate = runQualityGate(contrarianResult.post, {
            ...gateOptions(
              { format_slug: IDEA_SLUG, content: contrarianResult.post },
              profile, 'idea', null, 'contrarian'
            ),
            postType: 'contrarian',
          });

          const contrarianRunResult = await db.prepare(`
            INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
            VALUES (?, ?, ?, ?, ?)
            RETURNING id
          `).run(userId, tenantId, genPath, JSON.stringify({ raw_idea }), JSON.stringify(contrarianResult.synthesis));
          const contrarianRunId = contrarianRunResult.lastInsertRowid;

          const contrarianInsert = await db.prepare(`
            INSERT INTO generated_posts
              (run_id, user_id, tenant_id, profile_id, format_slug, content, ai_content, quality_score, quality_flags, passed_gate,
               funnel_type, vault_source_ref, idea_input, archetype_used, source,
               post_type, quality_verdict)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
          `).run(
            contrarianRunId, userId, tenantId, profile.id, IDEA_SLUG,
            contrarianResult.post, contrarianResult.post,
            contrarianGate.score, JSON.stringify(contrarianGate.flags), contrarianGate.passed_gate ? 1 : 0,
            'contrarian', null,
            raw_idea || null, null, source || null,
            'contrarian', contrarianGate.verdict || null
          );
          const contrarianId = contrarianInsert.lastInsertRowid;

          const contrarianQuality = buildQualityPayload(contrarianGate, 1, true);

          sseWrite('done', {
            post_id:          contrarianId,
            run_id:           contrarianRunId,
            post:             contrarianResult.post,
            quality:          { ...contrarianQuality, verdict: contrarianGate.verdict },
            archetypeUsed:    null,
            funnel_type:      'contrarian',
            post_type:        'contrarian',
            stage1Blueprint:  null,
            content_feedback: null,
          });
          return res.end();
        }

        // ── Framework / How-To path ───────────────────────────────────────
        if (post_type === 'framework') {
          sseWrite('step', { step: 'analyzing', label: 'Building your framework...' });

          const frameworkResult = await generateFrameworkPost(raw_idea, profile, {
            lengthPreference: length_preference || 'Medium',
          });

          sseWrite('step', { step: 'saving', label: 'Final quality check...' });

          const frameworkGate = runQualityGate(frameworkResult.post, {
            ...gateOptions(
              { format_slug: IDEA_SLUG, content: frameworkResult.post },
              profile, 'idea', null, 'framework'
            ),
            postType: 'framework',
          });

          const frameworkRunResult = await db.prepare(`
            INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
            VALUES (?, ?, ?, ?, ?)
            RETURNING id
          `).run(userId, tenantId, genPath, JSON.stringify({ raw_idea }), JSON.stringify(frameworkResult.synthesis));
          const frameworkRunId = frameworkRunResult.lastInsertRowid;

          const frameworkInsert = await db.prepare(`
            INSERT INTO generated_posts
              (run_id, user_id, tenant_id, profile_id, format_slug, content, ai_content, quality_score, quality_flags, passed_gate,
               funnel_type, vault_source_ref, idea_input, archetype_used, source,
               post_type, quality_verdict)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
          `).run(
            frameworkRunId, userId, tenantId, profile.id, IDEA_SLUG,
            frameworkResult.post, frameworkResult.post,
            frameworkGate.score, JSON.stringify(frameworkGate.flags), frameworkGate.passed_gate ? 1 : 0,
            'framework', null,
            raw_idea || null, null, source || null,
            'framework', frameworkGate.verdict || null
          );
          const frameworkId = frameworkInsert.lastInsertRowid;

          const frameworkQuality = buildQualityPayload(frameworkGate, 1, true);

          sseWrite('done', {
            post_id:          frameworkId,
            run_id:           frameworkRunId,
            post:             frameworkResult.post,
            quality:          { ...frameworkQuality, verdict: frameworkGate.verdict },
            archetypeUsed:    null,
            funnel_type:      'framework',
            post_type:        'framework',
            stage1Blueprint:  null,
            content_feedback: null,
          });
          return res.end();
        }

        // ── Announcement path ─────────────────────────────────────────────
        if (post_type === 'announcement') {
          sseWrite('step', { step: 'analyzing', label: 'Writing your announcement...' });

          const annResult = await generateAnnouncementPost(raw_idea, profile, {
            lengthPreference: length_preference || 'Medium',
          });

          sseWrite('step', { step: 'saving', label: 'Final quality check...' });

          const annGate = runQualityGate(annResult.post, {
            ...gateOptions(
              { format_slug: IDEA_SLUG, content: annResult.post },
              profile, 'idea', null, 'announcement'
            ),
            postType: 'announcement',
          });

          const annRunResult = await db.prepare(`
            INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
            VALUES (?, ?, ?, ?, ?)
            RETURNING id
          `).run(userId, tenantId, genPath, JSON.stringify({ raw_idea }), JSON.stringify(annResult.synthesis));
          const annRunId = annRunResult.lastInsertRowid;

          const annInsert = await db.prepare(`
            INSERT INTO generated_posts
              (run_id, user_id, tenant_id, profile_id, format_slug, content, ai_content, quality_score, quality_flags, passed_gate,
               funnel_type, vault_source_ref, idea_input, archetype_used, source,
               post_type, quality_verdict)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
          `).run(
            annRunId, userId, tenantId, profile.id, IDEA_SLUG,
            annResult.post, annResult.post,
            annGate.score, JSON.stringify(annGate.flags), annGate.passed_gate ? 1 : 0,
            'announcement', null,
            raw_idea || null, null, source || null,
            'announcement', annGate.verdict || null
          );
          const annId = annInsert.lastInsertRowid;

          const annQuality = buildQualityPayload(annGate, 1, true);

          sseWrite('done', {
            post_id:          annId,
            run_id:           annRunId,
            post:             annResult.post,
            quality:          { ...annQuality, verdict: annGate.verdict },
            archetypeUsed:    null,
            funnel_type:      'announcement',
            post_type:        'announcement',
            stage1Blueprint:  null,
            content_feedback: null,
          });
          return res.end();
        }

        // ── Lead Gen / Offer path ─────────────────────────────────────────
        if (post_type === 'lead_gen') {
          sseWrite('step', { step: 'analyzing', label: 'Crafting your offer post...' });

          const leadGenResult = await generateLeadGenPost(raw_idea, profile, {
            lengthPreference: length_preference || 'Medium',
          });

          sseWrite('step', { step: 'saving', label: 'Final quality check...' });

          const leadGenGate = runQualityGate(leadGenResult.post, {
            ...gateOptions(
              { format_slug: IDEA_SLUG, content: leadGenResult.post },
              profile, 'idea', null, 'lead_gen'
            ),
            postType: 'lead_gen',
          });

          const leadGenRunResult = await db.prepare(`
            INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
            VALUES (?, ?, ?, ?, ?)
            RETURNING id
          `).run(userId, tenantId, genPath, JSON.stringify({ raw_idea }), JSON.stringify(leadGenResult.synthesis));
          const leadGenRunId = leadGenRunResult.lastInsertRowid;

          const leadGenInsert = await db.prepare(`
            INSERT INTO generated_posts
              (run_id, user_id, tenant_id, profile_id, format_slug, content, ai_content, quality_score, quality_flags, passed_gate,
               funnel_type, vault_source_ref, idea_input, archetype_used, source,
               post_type, quality_verdict)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
          `).run(
            leadGenRunId, userId, tenantId, profile.id, IDEA_SLUG,
            leadGenResult.post, leadGenResult.post,
            leadGenGate.score, JSON.stringify(leadGenGate.flags), leadGenGate.passed_gate ? 1 : 0,
            'lead_gen', null,
            raw_idea || null, null, source || null,
            'lead_gen', leadGenGate.verdict || null
          );
          const leadGenId = leadGenInsert.lastInsertRowid;

          const leadGenQuality = buildQualityPayload(leadGenGate, 1, true);

          sseWrite('done', {
            post_id:          leadGenId,
            run_id:           leadGenRunId,
            post:             leadGenResult.post,
            quality:          { ...leadGenQuality, verdict: leadGenGate.verdict },
            archetypeUsed:    null,
            funnel_type:      'lead_gen',
            post_type:        'lead_gen',
            stage1Blueprint:  null,
            content_feedback: null,
          });
          return res.end();
        }

        // ── Problem-Insight-Solution path ──────────────────────────────────
        if (post_type === 'pis') {
          sseWrite('step', { step: 'analyzing', label: 'Crafting your PIS post...' });

          const pisResult = await generatePisPost(raw_idea, profile, {
            lengthPreference: length_preference || 'Medium',
          });

          sseWrite('step', { step: 'saving', label: 'Final quality check...' });

          const pisGate = runQualityGate(pisResult.post, {
            ...gateOptions(
              { format_slug: IDEA_SLUG, content: pisResult.post },
              profile, 'idea', null, 'pis'
            ),
            postType: 'pis',
          });

          const pisRunResult = await db.prepare(`
            INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
            VALUES (?, ?, ?, ?, ?)
            RETURNING id
          `).run(userId, tenantId, genPath, JSON.stringify({ raw_idea }), JSON.stringify(pisResult.synthesis));
          const pisRunId = pisRunResult.lastInsertRowid;

          const pisInsert = await db.prepare(`
            INSERT INTO generated_posts
              (run_id, user_id, tenant_id, profile_id, format_slug, content, ai_content, quality_score, quality_flags, passed_gate,
               funnel_type, vault_source_ref, idea_input, archetype_used, source,
               post_type, quality_verdict)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
          `).run(
            pisRunId, userId, tenantId, profile.id, IDEA_SLUG,
            pisResult.post, pisResult.post,
            pisGate.score, JSON.stringify(pisGate.flags), pisGate.passed_gate ? 1 : 0,
            'pis', null,
            raw_idea || null, null, source || null,
            'pis', pisGate.verdict || null
          );
          const pisId = pisInsert.lastInsertRowid;

          const pisQuality = buildQualityPayload(pisGate, 1, true);

          sseWrite('done', {
            post_id:          pisId,
            run_id:           pisRunId,
            post:             pisResult.post,
            quality:          { ...pisQuality, verdict: pisGate.verdict },
            archetypeUsed:    null,
            funnel_type:      'pis',
            post_type:        'pis',
            stage1Blueprint:  null,
            content_feedback: null,
          });
          return res.end();
        }

        // ── Standard path (Reach / Convert) ───────────────────────────────
        sseWrite('step', { step: 'analyzing', label: 'Analyzing your idea...' });

        const ideaRaw = await ideaToPost(raw_idea, profile, {
          skipSubstanceCheck:  !!skip_substance_check,
          postType:            post_type || null,
          convertCtaIntent:    convert_cta_intent || null,
          tensionStatement:    tension_statement || null,
          isInterviewPath,
          onStep:  (stepData) => sseWrite('step', stepData),
          onToken: (text)     => sseWrite('token', { text }),
        });

        sseWrite('step', { step: 'saving', label: 'Final quality check...' });

        const primaryGate = runQualityGate(ideaRaw.post, {
          ...gateOptions(
            { format_slug: IDEA_SLUG, content: ideaRaw.post },
            profile, 'idea', ideaRaw.archetypeUsed, funnelTypeForGate
          ),
          postType: post_type || null,
        });

        const runResult = await db.prepare(`
          INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
          VALUES (?, ?, ?, ?, ?)
          RETURNING id
        `).run(userId, tenantId, genPath, JSON.stringify({ raw_idea }), JSON.stringify(ideaRaw.synthesis));
        const runId = runResult.lastInsertRowid;

        const funnelType = post_type || (await classifyContent(ideaRaw.post)).funnelType;

        const primaryInsert = await db.prepare(`
          INSERT INTO generated_posts
            (run_id, user_id, tenant_id, profile_id, format_slug, content, ai_content, quality_score, quality_flags, passed_gate,
             funnel_type, vault_source_ref, idea_input, archetype_used, source,
             post_type, quality_verdict)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id
        `).run(
          runId, userId, tenantId, profile.id, IDEA_SLUG,
          ideaRaw.post, ideaRaw.post,
          primaryGate.score, JSON.stringify(primaryGate.flags), primaryGate.passed_gate ? 1 : 0,
          funnelType, null,
          raw_idea || null,
          ideaRaw.archetypeUsed || null,
          source || null,
          post_type || null,
          primaryGate.verdict || null
        );
        const primaryId = primaryInsert.lastInsertRowid;

        const primaryQuality = buildQualityPayload(primaryGate, 1, true);

        sseWrite('done', {
          post_id:         primaryId,
          run_id:          runId,
          post:            ideaRaw.post,
          quality:         { ...primaryQuality, verdict: primaryGate.verdict },
          archetypeUsed:   ideaRaw.archetypeUsed,
          funnel_type:     funnelType,
          post_type:       post_type || null,
          stage1Blueprint: ideaRaw.stage1Blueprint,
          content_feedback: ideaRaw.contentFeedback || null,
        });
        return res.end();

      } catch (sseErr) {
        if (sseErr.message === 'missing_substance') {
          sseWrite('error', { error: 'missing_substance', prompt: sseErr.substancePrompt, substance_tier: sseErr.substanceTier || 'warn' });
        } else if (sseErr.status === 429 || sseErr.status === 529) {
          sseWrite('error', { error: 'high_demand', retry_after_sec: 30 });
        } else {
          console.error('[generate/sse] error post_type=%s:', post_type, sseErr);
          sseWrite('error', { error: sseErr.message || 'generation_failed' });
        }
        return res.end();
      }
    }

    // ── Authority/Expertise path (non-streaming, trust post type) ────────────
    if (post_type === 'trust' && !vaultIdea) {
      const authorityResult = await generateAuthorityPost(raw_idea, profile, {
        lengthPreference: length_preference || 'Medium',
        ctaIntent:        cta_intent || '',
      });
      const primaryGate = runQualityGate(authorityResult.post, {
        ...gateOptions(
          { format_slug: IDEA_SLUG, content: authorityResult.post },
          profile, 'idea', null, 'trust'
        ),
        postType: 'trust',
      });
      ideaResult = {
        synthesis:       authorityResult.synthesis,
        post:            authorityResult.post,
        archetypeUsed:   null,
        primaryGate,
        contentFeedback: null,
      };
    } else if (post_type === 'story' && !vaultIdea) {
      // ── Story / Personal Experience path (non-streaming) ─────────────────
      const storyResult = await generateStoryPost(raw_idea, profile, {
        lengthPreference: length_preference || 'Medium',
        ctaIntent:        cta_intent || '',
      });
      const storyGate = runQualityGate(storyResult.post, {
        ...gateOptions(
          { format_slug: IDEA_SLUG, content: storyResult.post },
          profile, 'idea', null, 'story'
        ),
        postType: 'story',
      });
      ideaResult = {
        synthesis:       storyResult.synthesis,
        post:            storyResult.post,
        archetypeUsed:   null,
        primaryGate:     storyGate,
        contentFeedback: null,
      };
    } else if (post_type === 'lessons_learned' && !vaultIdea) {
      // ── Lessons Learned path (non-streaming) ─────────────────────────────
      const lessonsResult = await generateLessonsLearnedPost(raw_idea, profile, {
        lengthPreference: length_preference || 'Medium',
        ctaIntent:        cta_intent || '',
      });
      const lessonsGate = runQualityGate(lessonsResult.post, {
        ...gateOptions(
          { format_slug: IDEA_SLUG, content: lessonsResult.post },
          profile, 'idea', null, 'lessons_learned'
        ),
        postType: 'lessons_learned',
      });
      ideaResult = {
        synthesis:       lessonsResult.synthesis,
        post:            lessonsResult.post,
        archetypeUsed:   null,
        primaryGate:     lessonsGate,
        contentFeedback: null,
      };
    } else if (post_type === 'bts' && !vaultIdea) {
      // ── Behind-the-Scenes path (non-streaming) ────────────────────────────
      const btsResult = await generateBtsPost(raw_idea, profile, {
        lengthPreference: length_preference || 'Medium',
        ctaIntent:        cta_intent || '',
      });
      const btsGate = runQualityGate(btsResult.post, {
        ...gateOptions(
          { format_slug: IDEA_SLUG, content: btsResult.post },
          profile, 'idea', null, 'bts'
        ),
        postType: 'bts',
      });
      ideaResult = {
        synthesis:       btsResult.synthesis,
        post:            btsResult.post,
        archetypeUsed:   null,
        primaryGate:     btsGate,
        contentFeedback: null,
      };
    } else if (post_type === 'contrarian' && !vaultIdea) {
      // ── Contrarian / Hot Take path (non-streaming) ────────────────────────
      const contrarianResult = await generateContrarianPost(raw_idea, profile, {
        lengthPreference: length_preference || 'Medium',
      });
      const contrarianGate = runQualityGate(contrarianResult.post, {
        ...gateOptions(
          { format_slug: IDEA_SLUG, content: contrarianResult.post },
          profile, 'idea', null, 'contrarian'
        ),
        postType: 'contrarian',
      });
      ideaResult = {
        synthesis:       contrarianResult.synthesis,
        post:            contrarianResult.post,
        archetypeUsed:   null,
        primaryGate:     contrarianGate,
        contentFeedback: null,
      };
    } else if (post_type === 'framework' && !vaultIdea) {
      // ── Framework / How-To path (non-streaming) ───────────────────────
      const frameworkResult = await generateFrameworkPost(raw_idea, profile, {
        lengthPreference: length_preference || 'Medium',
      });
      const frameworkGate = runQualityGate(frameworkResult.post, {
        ...gateOptions(
          { format_slug: IDEA_SLUG, content: frameworkResult.post },
          profile, 'idea', null, 'framework'
        ),
        postType: 'framework',
      });
      ideaResult = {
        synthesis:       frameworkResult.synthesis,
        post:            frameworkResult.post,
        archetypeUsed:   null,
        primaryGate:     frameworkGate,
        contentFeedback: null,
      };
    } else if (post_type === 'announcement' && !vaultIdea) {
      // ── Announcement path (non-streaming) ────────────────────────────────
      const annResult = await generateAnnouncementPost(raw_idea, profile, {
        lengthPreference: length_preference || 'Medium',
      });
      const annGate = runQualityGate(annResult.post, {
        ...gateOptions(
          { format_slug: IDEA_SLUG, content: annResult.post },
          profile, 'idea', null, 'announcement'
        ),
        postType: 'announcement',
      });
      ideaResult = {
        synthesis:       annResult.synthesis,
        post:            annResult.post,
        archetypeUsed:   null,
        primaryGate:     annGate,
        contentFeedback: null,
      };
    } else if (post_type === 'lead_gen' && !vaultIdea) {
      // ── Lead Gen / Offer path (non-streaming) ────────────────────────────
      const leadGenResult = await generateLeadGenPost(raw_idea, profile, {
        lengthPreference: length_preference || 'Medium',
      });
      const leadGenGate = runQualityGate(leadGenResult.post, {
        ...gateOptions(
          { format_slug: IDEA_SLUG, content: leadGenResult.post },
          profile, 'idea', null, 'lead_gen'
        ),
        postType: 'lead_gen',
      });
      ideaResult = {
        synthesis:       leadGenResult.synthesis,
        post:            leadGenResult.post,
        archetypeUsed:   null,
        primaryGate:     leadGenGate,
        contentFeedback: null,
      };
    } else if (post_type === 'pis' && !vaultIdea) {
      // ── Problem-Insight-Solution path (non-streaming) ────────────────────
      const pisResult = await generatePisPost(raw_idea, profile, {
        lengthPreference: length_preference || 'Medium',
      });
      const pisGate = runQualityGate(pisResult.post, {
        ...gateOptions(
          { format_slug: IDEA_SLUG, content: pisResult.post },
          profile, 'idea', null, 'pis'
        ),
        postType: 'pis',
      });
      ideaResult = {
        synthesis:       pisResult.synthesis,
        post:            pisResult.post,
        archetypeUsed:   null,
        primaryGate:     pisGate,
        contentFeedback: null,
      };
    } else if (vaultIdea) {
      // ── Vault path ────────────────────────────────────────────────────────
      const vaultResult = await vaultSeedToPost(vaultIdea, vaultChunkText, profile, {
        rawIdea:            raw_idea,
        neighborContext:    vaultNeighborContext || null,
        postType:           post_type || vaultIdea.funnel_type || null,
        tensionStatement:   tension_statement || null,
        convertCtaIntent:   convert_cta_intent || null,
        skipSubstanceCheck: true,
      });
      const primaryGate = runQualityGate(
        vaultResult.post,
        {
          ...gateOptions(
            { format_slug: IDEA_SLUG, content: vaultResult.post },
            profile,
            'idea',
            vaultResult.archetypeUsed,
            funnelTypeForGate
          ),
          postType: post_type || vaultIdea.funnel_type || null,
        }
      );
      ideaResult = {
        synthesis:      vaultResult.synthesis,
        post:           vaultResult.post,
        archetypeUsed:  vaultResult.archetypeUsed,
        primaryGate,
        contentFeedback: null,
      };
    } else {
      // ── Standard path: full two-stage pipeline (Haiku blueprint → Sonnet) ───
      const ideaRaw = await ideaToPost(raw_idea, profile, {
        skipSubstanceCheck:  !!skip_substance_check,
        archetypeOverride:   archetype_override || null,
        postType:            post_type || null,
        convertCtaIntent:    convert_cta_intent || null,
        tensionStatement:    tension_statement || null,
        isInterviewPath,
      });
      const primaryGate = runQualityGate(
        ideaRaw.post,
        {
          ...gateOptions(
            { format_slug: IDEA_SLUG, content: ideaRaw.post },
            profile,
            'idea',
            ideaRaw.archetypeUsed,
            funnelTypeForGate
          ),
          postType: post_type || null,
        }
      );
      ideaResult = {
        synthesis:       ideaRaw.synthesis,
        post:            ideaRaw.post,
        archetypeUsed:   ideaRaw.archetypeUsed,
        primaryGate,
        contentFeedback: ideaRaw.contentFeedback || null,
      };
    }

    {
      const {
        synthesis,
        post,
        archetypeUsed,
        primaryGate,
        contentFeedback,
      } = ideaResult;

      if (typeof post !== 'string' || !post.trim()) {
        throw new Error('generation returned no post content');
      }

      // Store vault_idea_id alongside raw_idea so regenerate can reinject chunk context
      const inputData = vaultIdea
        ? { raw_idea, vault_idea_id: vaultIdea.id }
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
      const funnelType = vaultIdea?.funnel_type || post_type || (await classifyContent(post)).funnelType;
      const vaultSourceRef = vaultIdea?.source_ref || null;

      const primaryInsert = await db.prepare(`
        INSERT INTO generated_posts
          (run_id, user_id, tenant_id, profile_id, format_slug, content, ai_content, quality_score, quality_flags, passed_gate,
           funnel_type, vault_source_ref, idea_input, archetype_used, source,
           post_type, quality_verdict)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `).run(
        runId,
        userId,
        tenantId,
        profile.id,
        IDEA_SLUG,
        post,
        post,
        primaryGate.score,
        JSON.stringify(primaryGate.flags),
        primaryGate.passed_gate ? 1 : 0,
        funnelType,
        vaultSourceRef,
        inputData.raw_idea || null,
        archetypeUsed || null,
        source || null,
        post_type || null,
        primaryGate.verdict || null
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
        id: primaryId,
        archetypeUsed,
        quality: { ...primaryQuality, verdict: primaryGate.verdict },
        alternative: null,
        funnel_type: funnelType,
        post_type: post_type || null,
        vault_source_ref: vaultSourceRef,
        content_feedback: contentFeedback || null,
      });
    }

  } catch (err) {
    if (err.message === 'missing_substance') {
      return res.status(422).json({ ok: false, error: 'missing_substance', prompt: err.substancePrompt, substance_tier: err.substanceTier || 'warn' });
    }
    // Anthropic rate-limit (429) or overload (529) — surface gracefully instead of crashing
    if (err.status === 429 || err.status === 529) {
      console.warn('[generate] Anthropic API capacity error:', err.status);
      return res.status(503).json({ ok: false, error: 'high_demand', retry_after_sec: 30 });
    }
    console.error('[generate] Error:', err.message);
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
             hook_b, hook_b_archetype, cta_alternatives, format_slug, funnel_type,
             asset_url, asset_preview_url, asset_type, asset_slide_count, first_comment,
             archetype_used, idea_input, post_type, quality_verdict
      FROM generated_posts
      WHERE id = ? AND tenant_id = ?
    `).get(postId, tenantId);
  } catch {
    row = await db.prepare(`
      SELECT id, content, quality_score, quality_flags, passed_gate,
             hook_b, hook_b_archetype, cta_alternatives, format_slug, funnel_type
      FROM generated_posts
      WHERE id = ? AND tenant_id = ?
    `).get(postId, tenantId);
  }

  if (!row) return res.status(404).json({ ok: false, error: 'post_not_found' });

  let flags = [];
  try { flags = JSON.parse(row.quality_flags || '[]'); } catch {}
  let ctaAlternatives = [];
  try { ctaAlternatives = JSON.parse(row.cta_alternatives || '[]'); } catch {}
  // Re-run the slim gate on current content to get phrase matches for in-editor highlighting.
  let freshMatches = {};
  try {
    const freshGate = runQualityGate(row.content || '', { postType: row.post_type || null, funnelType: row.funnel_type || null });
    freshMatches = freshGate.matches || {};
  } catch { /* non-fatal — matches just won't highlight */ }

  return res.json({
    ok: true,
    post: {
      id:                  row.id,
      content:             row.content,
      quality:             { score: row.quality_score || 0, passed: row.passed_gate === 1, flags, errors: flags, warnings: [], verdict: row.quality_verdict || null, matches: freshMatches },
      hookB:               row.hook_b || null,
      hookBArchetype:      row.hook_b_archetype || null,
      ctaAlternatives,
      archetypeUsed:       row.archetype_used || null,
      ideaInput:           row.idea_input     || null,
      funnelType:          row.funnel_type || null,
      postType:            row.post_type || null,
      qualityVerdict:      row.quality_verdict || null,
      assetUrl:            row.asset_url        || null,
      assetPreviewUrl:     row.asset_preview_url || null,
      assetType:           row.asset_type        || null,
      assetSlideCount:     row.asset_slide_count || 0,
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
    WHERE batch_id = ? AND tenant_id = ?
    ORDER BY id ASC
  `).all(batch_id, tenantId);

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
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
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
    return res.status(429).json({
      ok: false, error: 'monthly_quota_reached',
      plan: planCheck.plan, used: planCheck.current, limit: planCheck.limit,
      resets_at: planCheck.resets_at, upgrade_url: '/billing.html',
    });
  }

  const contentType = (req.headers['content-type'] || '').split(';')[0].trim();

  let docText        = '';
  let filename       = 'document';
  let fileBuffer     = null;
  let fileSourceType = null;
  let sourceUrl      = null;

  // Always skip the substance pre-check on the from-doc path — the user
  // provided a real document, which is already their substance signal.
  const skipSubstanceCheckDoc = true;
  if (contentType === 'application/json') {
    const body = req.body || {};
    const { url, vault_doc_id } = body;

    if (vault_doc_id) {
      // Use an already-indexed vault document — fetch its chunks from the database
      const doc = await db
        .prepare(`SELECT id, filename FROM vault_documents WHERE id = ? AND tenant_id = ? AND status = 'ready'`)
        .get(vault_doc_id, tenantId);
      if (!doc) {
        return res.status(404).json({ ok: false, error: 'vault_doc_not_found' });
      }
      filename = doc.filename;
      const chunks = await db
        .prepare(`SELECT content FROM vault_chunks WHERE document_id = ? ORDER BY chunk_index`)
        .all(vault_doc_id);
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
      return res.status(415).json({ ok: false, error: 'unsupported_file_type', allowed: ['pdf', 'docx', 'pptx', 'txt'] });
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

  const profile = await resolveProfile(tenantId, req.body.profileId);
  if (!profile) return res.status(400).json({ ok: false, error: 'complete_profile_first' });

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) return res.status(500).json({ ok: false, error: 'no_api_key' });

  try {
    const { synthesis, post, archetypeUsed, stage1Blueprint } =
      await ideaToPost(truncated, profile, { skipSubstanceCheck: skipSubstanceCheckDoc });

    const primaryGate = runQualityGate(
      post,
      gateOptions(
        { format_slug: IDEA_SLUG, content: post },
        profile,
        'doc',
        archetypeUsed,
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
        (run_id, user_id, tenant_id, profile_id, format_slug, content, ai_content, quality_score, quality_flags, passed_gate,
         funnel_type, vault_source_ref, idea_input, archetype_used, source, post_type, quality_verdict)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).run(
      runId, userId, tenantId, profile.id, IDEA_SLUG,
      post, post, primaryGate.score, JSON.stringify(primaryGate.flags), primaryGate.passed_gate ? 1 : 0,
      funnelType, null, truncated, archetypeUsed || null, 'doc', null, primaryGate.verdict || null
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
      id:              primaryId,
      archetypeUsed,
      quality:         primaryQuality,
      alternative:     null,
      funnel_type:     funnelType,
      vault_source_ref: null,
      content_feedback: null,
      from_doc:        true,
      stage1Blueprint: stage1Blueprint || null,
    });

  } catch (err) {
    if (err.message === 'missing_substance') {
      return res.status(422).json({ ok: false, error: 'missing_substance', prompt: err.substancePrompt, substance_tier: err.substanceTier || 'warn' });
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
// Body: { postText, archetypeUsed, funnel_type }
// ---------------------------------------------------------------------------
router.post('/quality-check', async (req, res) => {
  const userId = req.userId;
  const tenantId = req.tenantId;
  const { postText, archetypeUsed = null, funnel_type = null } = req.body;

  if (!postText || typeof postText !== 'string') {
    return res.status(400).json({ ok: false, error: 'postText is required' });
  }

  const profile = tenantId
    ? await db.prepare('SELECT * FROM profiles WHERE workspace_id = ? AND is_default = true').get(tenantId)
    : null;

  const quality = runQualityGate(postText, {
    archetypeUsed: archetypeUsed ?? null,
    voiceProfile: profile || {},
    path: 'idea',
    funnelType: funnel_type ?? null,
  });

  return res.json({ ok: true, quality });
});

// ---------------------------------------------------------------------------
// POST /api/generate/extract-tension
// Runs Haiku tension extraction on Q1 answer. Never blocking — returns
// { tension: null, missing: null } on any error.
// Body: { post_type, answer }
// ---------------------------------------------------------------------------
router.post('/extract-tension', async (req, res) => {
  const userId = req.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const { post_type, answer } = req.body;
  if (!post_type || !answer?.trim()) {
    return res.status(400).json({ ok: false, error: 'post_type and answer are required' });
  }

  try {
    const { extractTension } = require('../services/tensionExtractor');
    const result = await extractTension(post_type, answer);
    return res.json({ ok: true, tension: result.tension, missing: result.missing });
  } catch {
    return res.json({ ok: true, tension: null, missing: null });
  }
});

// ---------------------------------------------------------------------------
// POST /api/generate/chat-intake
// Adaptive conversational coach. Scores the brief on 4 substance dimensions,
// returns a targeted question + skip suggestion if gaps remain, or ready:true
// when the brief is strong enough to generate a top post.
// Body: { brief, history: [{role,content}], post_type, exchange_count }
// Never blocking — returns ready:true on any error so generation can proceed.
// ---------------------------------------------------------------------------
router.post('/chat-intake', async (req, res) => {
  const { userId, tenantId } = req;
  if (!userId) return res.status(400).json({ ok: true, ready: true });

  const { brief, history = [], post_type, exchange_count = 0 } = req.body;
  if (!brief?.trim()) return res.json({ ok: true, ready: true });

  // Hard cap: after 4 exchanges always generate — don't over-interrogate
  // (The LLM prompt also says >=2 → ready:true, but we enforce it server-side for reliability)
  if (exchange_count >= 4) return res.json({ ok: true, ready: true });

  try {
    const profile = await db.prepare(`
      SELECT p.authority_statements, p.voice_fingerprint, p.onboarding_q2,
             bvp.brand_description, bvp.brand_core_beliefs,
             ap.audience_description, ap.audience_obstacles
      FROM   profiles p
      LEFT JOIN brand_voice_profiles bvp ON bvp.profile_id = p.id
      LEFT JOIN audience_profiles ap ON ap.profile_id = p.id
      WHERE  p.workspace_id = ? AND p.is_default = true
    `).get(tenantId);

    const brandDesc  = profile?.brand_description || '';
    const audience   = profile?.audience_description || '';
    let   pain       = '';
    try {
      const obstacles = JSON.parse(profile?.audience_obstacles || '[]');
      pain = obstacles[0] || '';
    } catch {}
    let contrarianTake = '';
    try {
      const beliefs = JSON.parse(profile?.brand_core_beliefs || '[]');
      contrarianTake = beliefs[0] || '';
    } catch {}
    const q2voice  = profile?.onboarding_q2 || '';
    let authStatements = [];
    try { authStatements = JSON.parse(profile?.authority_statements || '[]').slice(0, 2); } catch {}
    let fp = {};
    try { fp = JSON.parse(profile?.voice_fingerprint || '{}'); } catch {}
    const pos = fp.positioning || {};

    const Anthropic = require('@anthropic-ai/sdk');
    const apiKey    = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) return res.json({ ok: true, ready: true });

    const client = new Anthropic({ apiKey });

    // Build conversation history string for context
    const historyStr = history.length
      ? '\n\nCONVERSATION SO FAR:\n' + history.map(m =>
          `${m.role === 'user' ? 'Creator' : 'Coach'}: ${m.content}`
        ).join('\n')
      : '';

    const profileCtx = [
      brandDesc      && `What they do: ${brandDesc}`,
      audience       && `Their audience: ${audience}`,
      pain           && `Audience challenge: ${pain}`,
      contrarianTake && `Their POV: ${contrarianTake}`,
      pos.stands_for && `Stands for: ${pos.stands_for}`,
      pos.outcome    && `Outcome they deliver: ${pos.outcome}`,
      authStatements.length && `Proof points: ${authStatements.join('; ')}`,
      q2voice  && `Their natural voice (from an interview): "${q2voice.slice(0, 200)}"`,
    ].filter(Boolean).join('\n');

    const prompt = `You are a world-class LinkedIn editor coaching a ${brandDesc || 'professional'} creator to write a top 1% post.

CREATOR PROFILE:
${profileCtx}

THEIR BRIEF:
"${brief.slice(0, 600)}"
${historyStr}

POST TYPE: ${post_type || 'general'}

YOUR JOB:
Score this brief on 4 dimensions. A dimension scores TRUE only if the brief actually contains that element — not if it could be inferred.

1. HAS_MOMENT: A specific scene, situation, or time reference ("I was on a call with X", "last March", "a client told me", a named event)
2. HAS_PROOF: A concrete number, timeframe, or named result ("doubled in 6 weeks", "$40k", "3 clients", "in Q3")
3. HAS_TENSION: A contradiction, before/after, common belief vs reality, or surprising outcome ("everyone thinks X but actually Y", "I used to believe X until...")
4. HAS_AUDIENCE: Clear connection to who this helps and why they specifically need this ("${audience || 'their audience'}" feels seen)

RULES:
- If 3 or more dimensions score TRUE → set ready: true, no question needed
- If exchange_count >= 4 → set ready: true regardless (don't over-interrogate)
- Otherwise identify the SINGLE most important missing dimension and ask ONE targeted, conversational question
- The question must reference something specific from their brief — NOT generic
- Also write a skip_suggestion: a 1-2 sentence plausible answer they could use, written in first person, grounded in their profile and niche
- The skip_suggestion should feel specific to them, not generic — use their niche, audience, and proof points

Return ONLY valid JSON, nothing else:
{
  "scores": { "has_moment": bool, "has_proof": bool, "has_tension": bool, "has_audience": bool },
  "ready": bool,
  "question": "one conversational question referencing their specific brief, or null if ready",
  "skip_suggestion": "1-2 sentence first-person suggested answer grounded in their profile, or null if ready",
  "gap": "moment|proof|tension|audience|null"
}`;

    const message = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 350,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content[0]?.text?.trim() || '{}';
    let result = {};
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      result = JSON.parse(match ? match[0] : raw);
    } catch { return res.json({ ok: true, ready: true }); }

    return res.json({
      ok:              true,
      ready:           !!result.ready,
      question:        result.question        || null,
      skip_suggestion: result.skip_suggestion || null,
      gap:             result.gap             || null,
      scores:          result.scores          || {},
    });

  } catch (err) {
    console.error('[chat-intake] error (non-fatal):', err.message);
    return res.json({ ok: true, ready: true }); // fail open — let them generate
  }
});

// ---------------------------------------------------------------------------
// POST /api/generate/improve
// Chat-based post improver. Reshapes the current post text using the refine
// prompt (copy-editor model: tightens what is there, never invents).
// Uses brand voice profile + vault chunk context when available.
// Body: { postId, instruction, currentText, history? }
// ---------------------------------------------------------------------------
router.post('/improve', async (req, res) => {
  const { userId, tenantId } = req;
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const { postId, instruction, currentText, history = [] } = req.body;

  if (!currentText?.trim()) {
    return res.status(400).json({ ok: false, error: 'currentText is required' });
  }
  if (!instruction?.trim()) {
    return res.status(400).json({ ok: false, error: 'instruction is required' });
  }

  // Fetch post metadata to get post_type, funnel_type, archetype, profile, and vault context
  let postMeta = null;
  if (postId) {
    try {
      postMeta = await db.prepare(`
        SELECT gp.post_type, gp.funnel_type, gp.archetype_used, gp.profile_id, gr.input_data
        FROM   generated_posts gp
        LEFT   JOIN generation_runs gr ON gr.id = gp.run_id
        WHERE  gp.id = ? AND gp.tenant_id = ?
        LIMIT  1
      `).get(postId, tenantId);
    } catch { /* non-fatal — proceed without post metadata */ }
  }

  let profile = await resolveProfile(tenantId);
  if (!profile) return res.status(400).json({ ok: false, error: 'complete_profile_first' });

  // Fetch vault chunk context if this post was generated from a vault idea
  let vaultContext = null;
  try {
    let vaultIdeaId = null;
    if (postMeta?.input_data) {
      const inputData = JSON.parse(postMeta.input_data);
      vaultIdeaId = inputData?.vault_idea_id || null;
    }
    if (vaultIdeaId) {
      const vaultIdea = await db.prepare(
        'SELECT chunk_id FROM vault_ideas WHERE id = ? AND tenant_id = ?'
      ).get(vaultIdeaId, tenantId);
      if (vaultIdea?.chunk_id) {
        const chunk = await db.prepare(
          'SELECT content FROM vault_chunks WHERE id = ? AND tenant_id = ?'
        ).get(vaultIdea.chunk_id, tenantId);
        if (chunk?.content) vaultContext = chunk.content.slice(0, 2000);
      }
    }
  } catch { /* non-fatal — improve without vault context */ }

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) return res.status(500).json({ ok: false, error: 'no_api_key' });

  try {
    const { buildImproveSystemPrompt } = require('../services/ideaPath');
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const systemPrompt = buildImproveSystemPrompt(profile);

    // Build real multi-turn conversation from history.
    // history arrives as [{role:'user', content: instruction}, {role:'assistant', content: improved_post}]
    // — pass them as actual API message turns so Claude tracks conversational evolution.
    const messages = [];
    for (const turn of history.slice(-8)) {
      messages.push({
        role:    turn.role === 'assistant' ? 'assistant' : 'user',
        content: turn.content,
      });
    }

    // Final user turn always includes the full current post so Claude has the exact
    // current state (user may have manually edited since the last AI turn).
    const vaultBlock = vaultContext
      ? `SOURCE MATERIAL (from the author's vault):\n<source>\n${vaultContext}\n</source>\n\n`
      : '';

    messages.push({
      role:    'user',
      content: `${vaultBlock}CURRENT POST:\n${currentText}\n\nINSTRUCTION: ${instruction}\n\nReturn ONLY valid JSON:\n{\n  "synthesis": {\n    "suggested_angle": "one sentence: what changed and why",\n    "recommended_structure": "one sentence on structure",\n    "supporting_insight": "the closing CTA used"\n  },\n  "post": "full revised post text"\n}\n\nNo markdown fences. No explanation. Only the JSON object.`,
    });

    // Extended thinking lets Claude reason through what to change vs. preserve before writing.
    // This is the single biggest quality improvement for surgical editing tasks.
    const message = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 10000,
      thinking:   { type: 'enabled', budget_tokens: 4000 },
      system:     systemPrompt,
      messages,
    });

    const textBlock = message.content.find(b => b.type === 'text');
    const raw = textBlock?.text?.trim() || '{}';
    let result = {};
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      result = JSON.parse(match ? match[0] : raw);
    } catch {
      return res.status(500).json({ ok: false, error: 'parse_failed' });
    }

    if (!result.post?.trim()) {
      return res.status(500).json({ ok: false, error: 'empty_result' });
    }

    return res.json({
      ok:   true,
      post: result.post,
      note: result.synthesis?.suggested_angle || null,
    });

  } catch (err) {
    if (err.status === 429 || err.status === 529) {
      return res.status(503).json({ ok: false, error: 'high_demand', retry_after_sec: 30 });
    }
    console.error('[improve] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

'use strict';

// Carousel Studio draft routes — mounted at /api/posts
//
//   POST /:postId/carousel-draft          { pack_id } → create from AI extraction
//                                         (idempotent: returns the existing draft if one exists)
//   GET  /:postId/carousel-draft          → fetch draft (404 if none)
//   PUT  /:postId/carousel-draft          { deck } → validate + save (autosave target)
//   POST /:postId/carousel-draft/render   → start render job (poll /api/visuals/jobs/:jobId)

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../db');
const { loadPack, extractCarouselPackContent, startCarouselDeckJob } = require('../services/carouselPackRenderer');
const { buildDeckFromExtract, validateDeck, getDraft, upsertDraft, rewriteSlide } = require('../services/carouselDeck');
const { canGenerateVisual, logVisualGeneration, getUserPlan } = require('../services/subscription');
const { planHasFeature } = require('../lib/planFeatures');

async function loadOwnedPost(postId, userId, tenantId) {
  return db.prepare(
    'SELECT * FROM generated_posts WHERE id = ? AND user_id = ? AND tenant_id = ?'
  ).get(postId, userId, tenantId);
}

async function loadWorkspaceBrand(tenantId) {
  const profile = await db.prepare(
    'SELECT brand_bg, brand_accent, brand_text, brand_secondary_bg, brand_secondary_text FROM workspaces WHERE id = ?'
  ).get(tenantId);
  return {
    bg:             profile?.brand_bg             || '#0F1A3C',
    accent:         profile?.brand_accent         || '#0D7A5F',
    text:           profile?.brand_text           || '#F0F4FF',
    secondary_bg:   profile?.brand_secondary_bg   || null,
    secondary_text: profile?.brand_secondary_text || null,
  };
}

// Shared preamble: auth + ownership. Returns null after responding on failure.
async function requirePost(req, res) {
  const { userId, tenantId } = req;
  if (!userId) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return null; }
  const post = await loadOwnedPost(req.params.postId, userId, tenantId);
  if (!post) { res.status(404).json({ ok: false, error: 'post_not_found' }); return null; }
  return post;
}

// ── POST /:postId/carousel-draft — create (or return existing) ─────────────
router.post('/:postId/carousel-draft', async (req, res) => {
  try {
    const post = await requirePost(req, res);
    if (!post) return;
    const { userId, tenantId } = req;

    // Carousel is a Pro feature (mirrors routes/generate.js gate)
    const plan = await getUserPlan(userId);
    if (!planHasFeature(plan, 'carousel')) {
      return res.status(403).json({ ok: false, error: 'feature_not_available', feature: 'carousel', requiredPlan: 'pro' });
    }

    const existing = await getDraft(post.id, userId, tenantId);
    if (existing && !req.body?.force) {
      return res.json({ ok: true, draft: existing, created: false });
    }

    const packId = req.body?.pack_id;
    if (!packId) return res.status(400).json({ ok: false, error: 'pack_id_required' });
    const loaded = await loadPack(packId);
    if (!loaded) return res.status(404).json({ ok: false, error: 'pack_not_found' });

    const extracted = await extractCarouselPackContent(post, loaded.pack, loaded.slides);
    const deck = buildDeckFromExtract(loaded.pack, loaded.slides, extracted);
    const draft = await upsertDraft(post.id, userId, tenantId, deck);

    return res.json({ ok: true, draft, created: true });
  } catch (err) {
    console.error('[carouselDrafts] create error:', err.message);
    return res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ── GET /:postId/carousel-draft ─────────────────────────────────────────────
router.get('/:postId/carousel-draft', async (req, res) => {
  try {
    const post = await requirePost(req, res);
    if (!post) return;
    const draft = await getDraft(post.id, req.userId, req.tenantId);
    if (!draft) return res.status(404).json({ ok: false, error: 'draft_not_found' });
    return res.json({ ok: true, draft });
  } catch (err) {
    console.error('[carouselDrafts] get error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PUT /:postId/carousel-draft — validated save (autosave target) ─────────
router.put('/:postId/carousel-draft', async (req, res) => {
  try {
    const post = await requirePost(req, res);
    if (!post) return;
    const { userId, tenantId } = req;

    const deck = req.body?.deck;
    if (!deck || typeof deck !== 'object') {
      return res.status(400).json({ ok: false, error: 'deck_required' });
    }

    const loaded = await loadPack(deck.pack_id);
    if (!loaded) return res.status(404).json({ ok: false, error: 'pack_not_found' });

    const clean = validateDeck(deck, loaded.pack, [...loaded.slides, ...(loaded.variants || [])]);
    const draft = await upsertDraft(post.id, userId, tenantId, clean);
    return res.json({ ok: true, draft });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ ok: false, error: err.message });
    console.error('[carouselDrafts] save error:', err.message);
    return res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ── POST /:postId/carousel-draft/render — start render job ─────────────────
router.post('/:postId/carousel-draft/render', async (req, res) => {
  try {
    const post = await requirePost(req, res);
    if (!post) return;
    const { userId, tenantId } = req;

    const visualCheck = await canGenerateVisual(userId, tenantId);
    if (!visualCheck.allowed) {
      return res.status(403).json({
        ok: false, error: 'plan_limit_exceeded',
        plan: visualCheck.plan, current: visualCheck.current,
        limit: visualCheck.limit, reason: visualCheck.reason,
      });
    }

    const draft = await getDraft(post.id, userId, tenantId);
    if (!draft) return res.status(404).json({ ok: false, error: 'draft_not_found' });

    // Re-validate before rendering — the deck may predate pack changes
    const loaded = await loadPack(draft.deck.pack_id);
    if (!loaded) return res.status(404).json({ ok: false, error: 'pack_not_found' });
    const deck = validateDeck(draft.deck, loaded.pack, [...loaded.slides, ...(loaded.variants || [])]);

    const brand = await loadWorkspaceBrand(tenantId);
    const jobId = crypto.randomUUID();
    startCarouselDeckJob(jobId, post, deck, brand, { userId, tenantId });
    await logVisualGeneration(userId, tenantId, post.id, 'carousel_pack');

    return res.json({ ok: true, status: 'rendering', job_id: jobId });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ ok: false, error: err.message });
    console.error('[carouselDrafts] render error:', err.message);
    return res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ── POST /:postId/carousel-draft/slide-rewrite — per-slide AI action ────────
router.post('/:postId/carousel-draft/slide-rewrite', async (req, res) => {
  try {
    const post = await requirePost(req, res);
    if (!post) return;
    const { userId, tenantId } = req;

    const { slide_id, action } = req.body || {};
    if (!slide_id || !action) return res.status(400).json({ ok: false, error: 'slide_id_and_action_required' });

    const draft = await getDraft(post.id, userId, tenantId);
    if (!draft) return res.status(404).json({ ok: false, error: 'draft_not_found' });

    const slide = (draft.deck.slides || []).find(s => s.id === slide_id);
    if (!slide) return res.status(404).json({ ok: false, error: 'slide_not_found' });

    const slots = await rewriteSlide(post, slide, action);

    // Persist server-side too so a lost autosave doesn't drop the result
    slide.slots = { ...slide.slots, ...slots };
    slide.locked = true;
    await upsertDraft(post.id, userId, tenantId, draft.deck);

    return res.json({ ok: true, slots });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ ok: false, error: err.message });
    console.error('[carouselDrafts] slide-rewrite error:', err.message);
    return res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

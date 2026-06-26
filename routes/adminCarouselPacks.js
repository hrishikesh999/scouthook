'use strict';

const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();
const { db }  = require('../db');
const storage = require('../services/storage');
const { readSlotManifest, stripScriptTags } = require('../services/templateSlotInjector');
const { generateTemplateThumbnail } = require('../services/templateRenderer');
const { convertCarouselImages } = require('../services/carouselFromImages');
const { redisSet, redisGet } = require('../services/redis');

// ---------------------------------------------------------------------------
// Async conversion job queue
// ---------------------------------------------------------------------------

const conversionJobs = new Map();
const JOB_TTL_SECONDS = 900; // 15 minutes

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_SECONDS * 1000;
  for (const [id, job] of conversionJobs) {
    if (job.createdAt < cutoff) conversionJobs.delete(id);
  }
}, 60_000);

async function _setConversionJob(jobId, data) {
  const stored = await redisSet(`carousel_convert:${jobId}`, data, JOB_TTL_SECONDS);
  if (!stored) conversionJobs.set(jobId, { ...data, createdAt: Date.now() });
}

async function _getConversionJob(jobId) {
  const fromRedis = await redisGet(`carousel_convert:${jobId}`);
  if (fromRedis) return fromRedis;
  return conversionJobs.get(jobId) || null;
}

// ---------------------------------------------------------------------------
// Auth (same pattern as adminHtmlTemplates.js)
// ---------------------------------------------------------------------------

if (!process.env.ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD environment variable is required.');
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function requireAdminPassword(req, res, next) {
  const provided = req.headers['x-admin-password'] || req.body?.admin_password;
  if (provided !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

router.use(requireAdminPassword);

// ---------------------------------------------------------------------------
// GET / — list all carousel packs with slides
// ---------------------------------------------------------------------------

router.get('/', async (req, res) => {
  try {
    const packs = await db.prepare(
      `SELECT id, name, description, thumbnail_r2_key, category,
              variable_map, min_content_slides, max_content_slides,
              active, sort_order, created_at
       FROM carousel_packs
       ORDER BY sort_order, created_at DESC`
    ).all();

    // Load slides for each pack
    for (const pack of packs) {
      pack.slides = await db.prepare(
        `SELECT s.id, s.template_id, s.role, s.slide_order,
                t.name AS template_name, t.thumbnail_r2_key AS template_thumbnail
         FROM carousel_pack_slides s
         JOIN html_templates t ON t.id = s.template_id
         WHERE s.pack_id = ?
         ORDER BY s.slide_order`
      ).all(pack.id);
    }

    res.json({ ok: true, packs });
  } catch (err) {
    console.error('[adminCarouselPacks] GET / error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /from-images — bulk convert slide images into a carousel pack
//
// Frontend sends a JSON body with base64-encoded images:
// { name, description, category, min_content_slides, max_content_slides,
//   slides: [{ data: "base64...", contentType: "image/png", role: "title" }] }
// ---------------------------------------------------------------------------

router.post('/from-images', express.json({ limit: '60mb' }), async (req, res) => {
  try {
    const { name, description, category, min_content_slides, max_content_slides, slides } = req.body || {};

    if (!name?.trim()) return res.status(400).json({ ok: false, error: 'name is required' });
    if (!Array.isArray(slides) || slides.length < 2) {
      return res.status(400).json({ ok: false, error: 'At least 2 slide images required' });
    }

    const validRoles = new Set(['title', 'content', 'closing']);
    for (const s of slides) {
      if (!s.data || !s.contentType) {
        return res.status(400).json({ ok: false, error: 'Each slide must have data and contentType' });
      }
      if (!validRoles.has(s.role)) {
        return res.status(400).json({ ok: false, error: `Invalid role: ${s.role}` });
      }
    }

    // Convert base64 to buffers before starting the background job
    const images = slides.map(s => ({
      buffer: Buffer.from(s.data, 'base64'),
      contentType: s.contentType,
    }));
    const roles = slides.map(s => s.role);

    const jobId = crypto.randomUUID();
    const total = slides.length;

    // Set initial job state synchronously
    conversionJobs.set(jobId, {
      status: 'converting', progress: { current: 0, total }, pack_id: null, error: null, createdAt: Date.now(),
    });
    _setConversionJob(jobId, { status: 'converting', progress: { current: 0, total }, pack_id: null, error: null });

    // Return immediately — frontend polls /jobs/:jobId
    res.json({ ok: true, job_id: jobId });

    // Run conversion in background
    _runConversionJob(jobId, images, roles, { name: name.trim(), description, category, min_content_slides, max_content_slides });
  } catch (err) {
    console.error('[adminCarouselPacks] from-images error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function _runConversionJob(jobId, images, roles, meta) {
  const start = Date.now();
  const total = images.length;

  try {
    console.log('[adminCarouselPacks] job %s: converting %d slides, name=%s', jobId, total, meta.name);

    // Convert all images (carousel-aware)
    const { templates, variableMap } = await convertCarouselImages(images, roles, async (i) => {
      await _setConversionJob(jobId, {
        status: 'converting', progress: { current: i, total }, pack_id: null, error: null,
      });
    });

    console.log('[adminCarouselPacks] job %s: conversion done in %dms, saving templates', jobId, Date.now() - start);
    await _setConversionJob(jobId, { status: 'saving', progress: { current: total, total }, pack_id: null, error: null });

    // Save each template to html_templates (flagged as carousel slide)
    const savedSlides = [];
    for (let i = 0; i < templates.length; i++) {
      const t = templates[i];
      const role = roles[i];

      let manifest;
      try { manifest = readSlotManifest(t.html); } catch { manifest = t.manifest; }

      const cleanHtml = stripScriptTags(t.html);
      const templateId = crypto.randomUUID();
      const htmlKey = storage.buildTemplateKey(templateId);
      await storage.uploadAdmin(Buffer.from(cleanHtml, 'utf8'), htmlKey, 'text/html');

      let thumbnailKey = null;
      try {
        const thumbBuf = await generateTemplateThumbnail(cleanHtml, manifest);
        thumbnailKey = storage.buildThumbnailKey(templateId);
        await storage.uploadAdmin(thumbBuf, thumbnailKey, 'image/png');
      } catch (err) {
        console.warn('[adminCarouselPacks] thumbnail failed for slide %d: %s', i + 1, err.message);
      }

      await db.prepare(
        `INSERT INTO html_templates
           (id, name, description, category, html_r2_key, thumbnail_r2_key, slot_manifest, sort_order, is_carousel_slide)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE)`
      ).run(
        templateId,
        `${meta.name} — ${role} slide`,
        meta.description || null,
        meta.category || null,
        htmlKey,
        thumbnailKey,
        JSON.stringify(manifest),
        i,
      );

      savedSlides.push({ templateId, role, slideOrder: i });
    }

    // Create the carousel pack
    const packId = crypto.randomUUID();
    const packThumbnail = savedSlides.length > 0
      ? (await db.prepare('SELECT thumbnail_r2_key FROM html_templates WHERE id = ?')
          .get(savedSlides[0].templateId))?.thumbnail_r2_key
      : null;

    await db.prepare(
      `INSERT INTO carousel_packs
         (id, name, description, thumbnail_r2_key, category, variable_map,
          min_content_slides, max_content_slides, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      packId, meta.name, meta.description || null, packThumbnail,
      meta.category || null, JSON.stringify(variableMap),
      meta.min_content_slides || 3, meta.max_content_slides || 8,
    );

    for (const s of savedSlides) {
      await db.prepare(
        `INSERT INTO carousel_pack_slides (id, pack_id, template_id, role, slide_order)
         VALUES (?, ?, ?, ?, ?)`
      ).run(crypto.randomUUID(), packId, s.templateId, s.role, s.slideOrder);
    }

    console.log('[adminCarouselPacks] job %s: pack %s created with %d slides in %dms',
      jobId, packId, savedSlides.length, Date.now() - start);

    await _setConversionJob(jobId, {
      status: 'done', progress: { current: total, total }, pack_id: packId,
      slides_created: savedSlides.length, variable_map: variableMap, error: null,
    });
  } catch (err) {
    console.error('[adminCarouselPacks] job %s failed:', jobId, err.message);
    await _setConversionJob(jobId, { status: 'failed', progress: null, pack_id: null, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// GET /jobs/:jobId — poll conversion job status
// ---------------------------------------------------------------------------

router.get('/jobs/:jobId', async (req, res) => {
  const job = await _getConversionJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'job_not_found' });
  res.json({ ok: true, ...job });
});

// ---------------------------------------------------------------------------
// PUT /:id — update pack metadata, slides, or variable map
// ---------------------------------------------------------------------------

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, category, variable_map, min_content_slides, max_content_slides, sort_order } = req.body || {};

    const existing = await db.prepare('SELECT * FROM carousel_packs WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ ok: false, error: 'not_found' });

    const updates = [];
    const values = [];
    if (name !== undefined) { updates.push('name = ?'); values.push(name.trim()); }
    if (description !== undefined) { updates.push('description = ?'); values.push(description || null); }
    if (category !== undefined) { updates.push('category = ?'); values.push(category || null); }
    if (variable_map !== undefined) { updates.push('variable_map = ?'); values.push(JSON.stringify(variable_map)); }
    if (min_content_slides !== undefined) { updates.push('min_content_slides = ?'); values.push(Number(min_content_slides)); }
    if (max_content_slides !== undefined) { updates.push('max_content_slides = ?'); values.push(Number(max_content_slides)); }
    if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(Number(sort_order)); }

    if (updates.length) {
      values.push(id);
      await db.prepare(`UPDATE carousel_packs SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[adminCarouselPacks] PUT error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id — delete pack (slides cascade, templates remain)
// ---------------------------------------------------------------------------

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await db.prepare('SELECT * FROM carousel_packs WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ ok: false, error: 'not_found' });

    await db.prepare('DELETE FROM carousel_packs WHERE id = ?').run(id);

    if (existing.thumbnail_r2_key) {
      storage.removeAdmin(existing.thumbnail_r2_key).catch(e =>
        console.warn('[adminCarouselPacks] thumbnail cleanup failed:', e.message));
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[adminCarouselPacks] DELETE error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/toggle — toggle active
// ---------------------------------------------------------------------------

router.post('/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const row = await db.prepare('SELECT active FROM carousel_packs WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });

    const newActive = !row.active;
    await db.prepare('UPDATE carousel_packs SET active = ? WHERE id = ?').run(newActive, id);
    res.json({ ok: true, active: newActive });
  } catch (err) {
    console.error('[adminCarouselPacks] toggle error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/thumbnail — proxy thumbnail from R2
// ---------------------------------------------------------------------------

router.get('/:id/thumbnail', async (req, res) => {
  try {
    const row = await db.prepare('SELECT thumbnail_r2_key FROM carousel_packs WHERE id = ?').get(req.params.id);
    if (!row?.thumbnail_r2_key) return res.status(404).end();
    const buf = await storage.downloadAdmin(row.thumbnail_r2_key);
    res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=3600').send(buf);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

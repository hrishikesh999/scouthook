'use strict';

const express = require('express');
const router  = express.Router();
const { db }  = require('../db');
const storage = require('../services/storage');

// GET /api/carousel-packs — active packs for user gallery
router.get('/', async (req, res) => {
  try {
    const packs = await db.prepare(
      `SELECT id, name, description, category, variable_map,
              min_content_slides, max_content_slides, sort_order, thumbnail_r2_key
       FROM carousel_packs
       WHERE active = TRUE
       ORDER BY sort_order ASC, created_at DESC`
    ).all();

    for (const pack of packs) {
      pack.slides = await db.prepare(
        `SELECT s.template_id, s.role, s.slide_order,
                t.name AS template_name, t.thumbnail_r2_key AS template_thumbnail
         FROM carousel_pack_slides s
         JOIN html_templates t ON t.id = s.template_id
         WHERE s.pack_id = ?
         ORDER BY s.slide_order`
      ).all(pack.id);
    }

    res.json({ ok: true, packs });
  } catch (err) {
    console.error('[carouselPacks] GET / error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /:id — full pack detail for the Carousel Studio: slides with slot
// manifests, variable map, aspect ratio, and layout variants (templates
// linked via variant_group but not part of the pack's base slide sequence).
router.get('/:id', async (req, res) => {
  try {
    const pack = await db.prepare(
      'SELECT * FROM carousel_packs WHERE id = ? AND active = TRUE'
    ).get(req.params.id);
    if (!pack) return res.status(404).json({ ok: false, error: 'pack_not_found' });

    const slides = await db.prepare(
      `SELECT s.template_id, s.role, s.slide_order,
              t.name AS template_name, t.slot_manifest, t.variant_group
       FROM carousel_pack_slides s
       JOIN html_templates t ON t.id = s.template_id
       WHERE s.pack_id = ? AND t.active = TRUE
       ORDER BY s.slide_order`
    ).all(req.params.id);

    // Layout variants: active templates sharing a variant_group with any pack
    // slide, excluding the pack slides themselves. Role is inherited from the
    // pack slide that anchors the group.
    let variants = [];
    const groups = [...new Set(slides.map(s => s.variant_group).filter(Boolean))];
    if (groups.length) {
      const roleByGroup = {};
      for (const s of slides) if (s.variant_group) roleByGroup[s.variant_group] = s.role;
      const placeholders = groups.map(() => '?').join(', ');
      const slideIds = new Set(slides.map(s => s.template_id));
      const rows = await db.prepare(
        `SELECT id AS template_id, name AS template_name, slot_manifest, variant_group
         FROM html_templates
         WHERE variant_group IN (${placeholders}) AND active = TRUE`
      ).all(...groups);
      variants = rows
        .filter(r => !slideIds.has(r.template_id))
        .map(r => ({ ...r, role: roleByGroup[r.variant_group] || 'content' }));
    }

    const parseManifest = m => { try { return typeof m === 'string' ? JSON.parse(m) : (m || {}); } catch { return {}; } };
    for (const s of slides) s.slot_manifest = parseManifest(s.slot_manifest);
    for (const v of variants) v.slot_manifest = parseManifest(v.slot_manifest);

    res.json({
      ok: true,
      pack: {
        id: pack.id,
        name: pack.name,
        description: pack.description,
        category: pack.category,
        aspect_ratio: pack.aspect_ratio || 'square',
        variable_map: typeof pack.variable_map === 'string' ? JSON.parse(pack.variable_map) : (pack.variable_map || {}),
        min_content_slides: pack.min_content_slides,
        max_content_slides: pack.max_content_slides,
        slides,
        variants,
      },
    });
  } catch (err) {
    console.error('[carouselPacks] GET /:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /:id/thumbnail — proxy thumbnail
router.get('/:id/thumbnail', async (req, res) => {
  try {
    const row = await db.prepare(
      'SELECT thumbnail_r2_key FROM carousel_packs WHERE id = ? AND active = TRUE'
    ).get(req.params.id);
    if (!row?.thumbnail_r2_key) return res.status(404).end();
    const buf = await storage.downloadAdmin(row.thumbnail_r2_key);
    res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=3600').send(buf);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

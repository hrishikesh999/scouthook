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

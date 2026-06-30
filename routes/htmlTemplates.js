'use strict';

const express = require('express');
const router  = express.Router();
const { db }  = require('../db');
const storage = require('../services/storage');

// GET /api/html-templates — active templates for user gallery
router.get('/', async (req, res) => {
  try {
    const rows = await db.prepare(
      `SELECT id, name, description, category, slot_manifest, sort_order, thumbnail_r2_key
       FROM html_templates
       WHERE active = TRUE AND is_carousel_slide IS NOT TRUE
       ORDER BY sort_order ASC, created_at ASC`
    ).all();
    const templates = rows.map(t => {
      const publicUrl = t.thumbnail_r2_key ? storage.getPublicUrl(t.thumbnail_r2_key) : null;
      return publicUrl ? { ...t, thumbnail_url: publicUrl } : t;
    });
    res.json({ ok: true, templates });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/html-templates/:id/html — serve raw template HTML from R2
router.get('/:id/html', async (req, res) => {
  try {
    const row = await db.prepare(
      'SELECT html_r2_key FROM html_templates WHERE id = ? AND active = TRUE'
    ).get(req.params.id);
    if (!row?.html_r2_key) return res.status(404).end();
    const buf = await storage.downloadAdmin(row.html_r2_key);
    res.set('Content-Type', 'text/plain; charset=utf-8').send(buf);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/html-templates/:id/thumbnail — proxy thumbnail for authenticated users
router.get('/:id/thumbnail', async (req, res) => {
  try {
    const row = await db.prepare(
      'SELECT thumbnail_r2_key FROM html_templates WHERE id = ? AND active = TRUE'
    ).get(req.params.id);
    if (!row?.thumbnail_r2_key) return res.status(404).end();
    const buf = await storage.downloadAdmin(row.thumbnail_r2_key);
    res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=60').send(buf);
  } catch {
    res.status(404).end();
  }
});

module.exports = router;

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
       WHERE active = TRUE
       ORDER BY sort_order ASC, created_at ASC`
    ).all();
    res.json({ ok: true, templates: rows });
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
    res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=3600').send(buf);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

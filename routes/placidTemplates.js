'use strict';

const express = require('express');
const router  = express.Router();
const { db }  = require('../db');

// GET /api/placid-templates — list all global templates (used by editor to populate picker)
router.get('/', async (req, res) => {
  try {
    const rows = await db.prepare(
      'SELECT id, name, template_uuid, layer_headline, layer_subtext, preview_image_url, is_default, sort_order FROM placid_templates ORDER BY sort_order ASC, created_at ASC'
    ).all();
    return res.json({ ok: true, templates: rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

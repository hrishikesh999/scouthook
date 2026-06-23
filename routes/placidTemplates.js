'use strict';

const express = require('express');
const router  = express.Router();
const { db }  = require('../db');

function parseTextLayers(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

// GET /api/placid-templates — list all global templates (used by editor to populate picker)
router.get('/', async (req, res) => {
  try {
    const rows = await db.prepare(
      'SELECT id, name, template_uuid, layer_headline, layer_subtext, custom_layers, preview_image_url, is_default, sort_order FROM placid_templates ORDER BY sort_order ASC, created_at ASC'
    ).all();
    return res.json({
      ok: true,
      templates: rows.map(r => ({ ...r, text_layers: parseTextLayers(r.custom_layers), custom_layers: undefined })),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

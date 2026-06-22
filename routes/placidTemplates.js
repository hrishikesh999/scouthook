'use strict';

const express = require('express');
const router  = express.Router();
const { db }  = require('../db');

function parseCustomLayers(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

// GET /api/placid-templates — list all global templates (used by editor to populate picker)
router.get('/', async (req, res) => {
  try {
    const [rows, wsRow] = await Promise.all([
      db.prepare('SELECT * FROM placid_templates ORDER BY sort_order ASC, created_at ASC').all(),
      db.prepare(
        'SELECT brand_bg, brand_accent, brand_text, brand_name, brand_logo, brand_font_heading, brand_font_body, brand_secondary_bg, brand_secondary_text FROM workspaces WHERE id = ?'
      ).get(req.tenantId),
    ]);
    return res.json({
      ok: true,
      templates: rows.map(r => ({
        ...r,
        custom_layers: parseCustomLayers(r.custom_layers),
        brand_layers:  parseCustomLayers(r.brand_layers),
      })),
      brand: {
        bg:             wsRow?.brand_bg             || '#0F1A3C',
        accent:         wsRow?.brand_accent         || '#0D7A5F',
        text:           wsRow?.brand_text           || '#F0F4FF',
        name:           wsRow?.brand_name           || null,
        logo:           wsRow?.brand_logo           || null,
        font_heading:   wsRow?.brand_font_heading   || null,
        font_body:      wsRow?.brand_font_body      || null,
        secondary_bg:   wsRow?.brand_secondary_bg   || null,
        secondary_text: wsRow?.brand_secondary_text || null,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

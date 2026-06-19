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
    const rows = await db.prepare(
      'SELECT * FROM placid_templates ORDER BY sort_order ASC, created_at ASC'
    ).all();
    return res.json({ ok: true, templates: rows.map(r => ({ ...r, custom_layers: parseCustomLayers(r.custom_layers) })) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

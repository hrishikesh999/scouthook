'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../db');

// ---------------------------------------------------------------------------
// GET /api/recipes
// Returns all active recipes for the tenant, grouped by category.
// Questions are parsed from JSON so the UI never hardcodes them.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const tenantId = req.tenantId;

  const rows = await db.prepare(`
    SELECT slug, name, category, description, questions, suggested_visual, suitable_formats, sort_order
    FROM recipes
    WHERE is_active = 1 AND tenant_id = ?
    ORDER BY category, sort_order
  `).all(tenantId);

  // Group by category
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.category]) grouped[row.category] = [];
    grouped[row.category].push({
      slug: row.slug,
      name: row.name,
      category: row.category,
      description: row.description,
      questions: JSON.parse(row.questions),
      suitable_formats: JSON.parse(row.suitable_formats || '[]'),
      suggested_visual: row.suggested_visual,
    });
  }

  return res.json({ ok: true, recipes: grouped });
});

module.exports = router;

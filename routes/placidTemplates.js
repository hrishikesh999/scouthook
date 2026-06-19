'use strict';

const express = require('express');
const router  = express.Router();
const { db }  = require('../db');

// GET /api/placid-templates
router.get('/', async (req, res) => {
  const { tenantId } = req;
  try {
    const rows = await db.prepare(
      'SELECT * FROM placid_templates WHERE tenant_id = ? ORDER BY sort_order ASC, created_at ASC'
    ).all(tenantId);
    return res.json({ ok: true, templates: rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/placid-templates
router.post('/', async (req, res) => {
  const { tenantId } = req;
  const { name, template_uuid, layer_headline = 'headline', layer_subtext = 'subtext', preview_image_url = null } = req.body || {};

  if (!name || !template_uuid) {
    return res.status(400).json({ ok: false, error: 'name and template_uuid are required' });
  }

  try {
    const maxRow = await db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) AS mx FROM placid_templates WHERE tenant_id = ?'
    ).get(tenantId);
    const sortOrder = (maxRow?.mx ?? -1) + 1;

    const row = await db.prepare(`
      INSERT INTO placid_templates (tenant_id, name, template_uuid, layer_headline, layer_subtext, preview_image_url, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(tenantId, name, template_uuid, layer_headline, layer_subtext, preview_image_url, sortOrder);

    return res.status(201).json({ ok: true, template: row });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/placid-templates/:id
router.put('/:id', async (req, res) => {
  const { tenantId } = req;
  const { id } = req.params;
  const { name, template_uuid, layer_headline, layer_subtext, preview_image_url } = req.body || {};

  if (!name || !template_uuid) {
    return res.status(400).json({ ok: false, error: 'name and template_uuid are required' });
  }

  try {
    const row = await db.prepare(`
      UPDATE placid_templates
      SET name = ?, template_uuid = ?, layer_headline = ?, layer_subtext = ?, preview_image_url = ?
      WHERE id = ? AND tenant_id = ?
      RETURNING *
    `).get(name, template_uuid, layer_headline || 'headline', layer_subtext || 'subtext', preview_image_url || null, id, tenantId);

    if (!row) return res.status(404).json({ ok: false, error: 'template_not_found' });
    return res.json({ ok: true, template: row });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/placid-templates/:id
router.delete('/:id', async (req, res) => {
  const { tenantId } = req;
  const { id } = req.params;
  try {
    const row = await db.prepare(
      'DELETE FROM placid_templates WHERE id = ? AND tenant_id = ? RETURNING id'
    ).get(id, tenantId);
    if (!row) return res.status(404).json({ ok: false, error: 'template_not_found' });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/placid-templates/:id/set-default
router.post('/:id/set-default', async (req, res) => {
  const { tenantId } = req;
  const { id } = req.params;
  try {
    await db.prepare(
      'UPDATE placid_templates SET is_default = FALSE WHERE tenant_id = ?'
    ).run(tenantId);
    const row = await db.prepare(
      'UPDATE placid_templates SET is_default = TRUE WHERE id = ? AND tenant_id = ? RETURNING *'
    ).get(id, tenantId);
    if (!row) return res.status(404).json({ ok: false, error: 'template_not_found' });
    return res.json({ ok: true, template: row });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/placid-templates/reorder
// body: { ids: ['uuid', 'uuid', ...] }
router.post('/reorder', async (req, res) => {
  const { tenantId } = req;
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ ok: false, error: 'ids array required' });
  }
  try {
    for (let i = 0; i < ids.length; i++) {
      await db.prepare(
        'UPDATE placid_templates SET sort_order = ? WHERE id = ? AND tenant_id = ?'
      ).run(i, ids[i], tenantId);
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

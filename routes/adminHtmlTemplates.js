'use strict';

const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();
const { db }  = require('../db');
const storage = require('../services/storage');
const { readSlotManifest, stripScriptTags } = require('../services/templateSlotInjector');
const { generateTemplateThumbnail } = require('../services/templateRenderer');

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

if (!process.env.ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD environment variable is required.');
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function requireAdminPassword(req, res, next) {
  const provided = req.headers['x-admin-password'] || req.body?.admin_password;
  if (provided !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

router.use(requireAdminPassword);

// ---------------------------------------------------------------------------
// GET / — list all templates
// ---------------------------------------------------------------------------

router.get('/', async (req, res) => {
  try {
    const rows = await db.prepare(
      `SELECT id, name, description, category, active, sort_order,
              slot_manifest, html_r2_key, thumbnail_r2_key, created_at
       FROM html_templates
       ORDER BY sort_order ASC, created_at ASC`
    ).all();
    res.json({ ok: true, templates: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST / — create template (synchronous including thumbnail)
// ---------------------------------------------------------------------------

router.post('/', async (req, res) => {
  try {
    const { name, description, category, html, sort_order = 0 } = req.body || {};

    if (!name || !html) {
      return res.status(400).json({ ok: false, error: 'name and html are required' });
    }
    if (Buffer.byteLength(html, 'utf8') > 500 * 1024) {
      return res.status(400).json({ ok: false, error: 'html must be ≤ 500 KB' });
    }

    // Strip all <script> blocks before storing
    const cleanHtml = stripScriptTags(html);

    // Parse manifest — must have valid JSON if the block is present
    let manifest;
    try {
      manifest = readSlotManifest(cleanHtml);
    } catch (err) {
      return res.status(400).json({ ok: false, error: `invalid template-meta: ${err.message}` });
    }

    const id = crypto.randomUUID();
    const htmlKey = storage.buildTemplateKey(id);

    // Upload HTML to R2
    await storage.uploadAdmin(Buffer.from(cleanHtml, 'utf8'), htmlKey, 'text/html');

    // Generate thumbnail synchronously (admin waits ~3–5s)
    let thumbnailKey = null;
    let thumbnailWarning = null;
    try {
      const thumbBuf = await generateTemplateThumbnail(cleanHtml, manifest);
      thumbnailKey = storage.buildThumbnailKey(id);
      await storage.uploadAdmin(thumbBuf, thumbnailKey, 'image/png');
    } catch (thumbErr) {
      console.warn('[adminHtmlTemplates] thumbnail generation failed:', thumbErr.message);
      thumbnailWarning = thumbErr.message;
    }

    // Insert row
    const row = await db.prepare(
      `INSERT INTO html_templates
         (id, name, description, category, html_r2_key, thumbnail_r2_key, slot_manifest, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    ).get(
      id,
      name,
      description || null,
      category || null,
      htmlKey,
      thumbnailKey,
      JSON.stringify(manifest),
      Number(sort_order),
    );

    res.status(201).json({ ok: true, template: row, thumbnail_warning: thumbnailWarning });
  } catch (err) {
    console.error('[adminHtmlTemplates] POST error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /:id — update template
// ---------------------------------------------------------------------------

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, category, html, sort_order, active } = req.body || {};

    const existing = await db.prepare('SELECT * FROM html_templates WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ ok: false, error: 'not_found' });

    let htmlKey = existing.html_r2_key;
    let thumbnailKey = existing.thumbnail_r2_key;
    let manifest = existing.slot_manifest; // already parsed by pg
    let thumbnailWarning = null;

    if (html) {
      if (Buffer.byteLength(html, 'utf8') > 500 * 1024) {
        return res.status(400).json({ ok: false, error: 'html must be ≤ 500 KB' });
      }
      const cleanHtml = stripScriptTags(html);

      try {
        manifest = readSlotManifest(cleanHtml);
      } catch (err) {
        return res.status(400).json({ ok: false, error: `invalid template-meta: ${err.message}` });
      }

      // Overwrite the same R2 key
      await storage.uploadAdmin(Buffer.from(cleanHtml, 'utf8'), htmlKey, 'text/html');

      // Regenerate thumbnail
      try {
        const thumbBuf = await generateTemplateThumbnail(cleanHtml, manifest);
        thumbnailKey = storage.buildThumbnailKey(id);
        await storage.uploadAdmin(thumbBuf, thumbnailKey, 'image/png');
      } catch (thumbErr) {
        console.warn('[adminHtmlTemplates] thumbnail regen failed:', thumbErr.message);
        thumbnailWarning = thumbErr.message;
      }
    }

    const updates = {
      name:             name      ?? existing.name,
      description:      description !== undefined ? (description || null) : existing.description,
      category:         category  !== undefined ? (category || null) : existing.category,
      sort_order:       sort_order !== undefined ? Number(sort_order) : existing.sort_order,
      active:           active    !== undefined ? Boolean(active) : existing.active,
      slot_manifest:    JSON.stringify(manifest),
      thumbnail_r2_key: thumbnailKey,
    };

    const row = await db.prepare(
      `UPDATE html_templates
          SET name = ?, description = ?, category = ?, sort_order = ?,
              active = ?, slot_manifest = ?, thumbnail_r2_key = ?
        WHERE id = ?
        RETURNING *`
    ).get(
      updates.name, updates.description, updates.category,
      updates.sort_order, updates.active,
      updates.slot_manifest, updates.thumbnail_r2_key, id,
    );

    res.json({ ok: true, template: row, thumbnail_warning: thumbnailWarning });
  } catch (err) {
    console.error('[adminHtmlTemplates] PUT error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id — delete template + R2 objects
// ---------------------------------------------------------------------------

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const row = await db.prepare('SELECT html_r2_key, thumbnail_r2_key FROM html_templates WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });

    await db.prepare('DELETE FROM html_templates WHERE id = ?').run(id);

    // Clean up R2 objects (non-fatal if they fail)
    if (row.html_r2_key) {
      storage.removeAdmin(row.html_r2_key).catch(e =>
        console.warn('[adminHtmlTemplates] R2 html delete failed:', e.message)
      );
    }
    if (row.thumbnail_r2_key) {
      storage.removeAdmin(row.thumbnail_r2_key).catch(e =>
        console.warn('[adminHtmlTemplates] R2 thumb delete failed:', e.message)
      );
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/toggle — flip active boolean
// ---------------------------------------------------------------------------

router.post('/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const row = await db.prepare(
      'UPDATE html_templates SET active = NOT active WHERE id = ? RETURNING *'
    ).get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, template: row });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/html — serve raw template HTML from R2
// ---------------------------------------------------------------------------

router.get('/:id/html', async (req, res) => {
  try {
    const { id } = req.params;
    const row = await db.prepare('SELECT html_r2_key FROM html_templates WHERE id = ?').get(id);
    if (!row?.html_r2_key) return res.status(404).end();
    const buf = await storage.downloadAdmin(row.html_r2_key);
    res.set('Content-Type', 'text/plain; charset=utf-8').send(buf);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/thumbnail — proxy PNG from R2
// ---------------------------------------------------------------------------

router.get('/:id/thumbnail', async (req, res) => {
  try {
    const { id } = req.params;
    const row = await db.prepare('SELECT thumbnail_r2_key FROM html_templates WHERE id = ?').get(id);
    if (!row?.thumbnail_r2_key) return res.status(404).end();
    const buf = await storage.downloadAdmin(row.thumbnail_r2_key);
    res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=3600').send(buf);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/regenerate-thumbnail — re-generate when render service was down
// ---------------------------------------------------------------------------

router.post('/:id/regenerate-thumbnail', async (req, res) => {
  try {
    const { id } = req.params;
    const row = await db.prepare('SELECT * FROM html_templates WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });

    const htmlBuf = await storage.downloadAdmin(row.html_r2_key);
    const html = htmlBuf.toString('utf8');
    const manifest = row.slot_manifest; // pre-parsed JSONB

    const thumbBuf = await generateTemplateThumbnail(html, manifest);
    const thumbnailKey = storage.buildThumbnailKey(id);
    await storage.uploadAdmin(thumbBuf, thumbnailKey, 'image/png');
    await db.prepare('UPDATE html_templates SET thumbnail_r2_key = ? WHERE id = ?').run(thumbnailKey, id);

    res.json({ ok: true, thumbnail_r2_key: thumbnailKey });
  } catch (err) {
    console.error('[adminHtmlTemplates] regenerate-thumbnail error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

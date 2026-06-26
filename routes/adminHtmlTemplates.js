'use strict';

const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();
const { db }  = require('../db');
const storage = require('../services/storage');
const { readSlotManifest, stripScriptTags } = require('../services/templateSlotInjector');
const { generateTemplateThumbnail } = require('../services/templateRenderer');
const { generateTemplateFromImage } = require('../services/templateFromImage');

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
       WHERE is_carousel_slide = FALSE
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
    if (Buffer.byteLength(html, 'utf8') > 3 * 1024 * 1024) {
      return res.status(400).json({ ok: false, error: 'html must be ≤ 3 MB' });
    }

    // Parse manifest from the original HTML before stripping scripts
    let manifest;
    try {
      manifest = readSlotManifest(html);
    } catch (err) {
      return res.status(400).json({ ok: false, error: `invalid template-meta: ${err.message}` });
    }

    // Strip all <script> blocks before storing (after manifest is read)
    const cleanHtml = stripScriptTags(html);

    const id = crypto.randomUUID();
    const htmlKey = storage.buildTemplateKey(id);

    // Upload HTML to R2
    await storage.uploadAdmin(Buffer.from(cleanHtml, 'utf8'), htmlKey, 'text/html');

    // Generate thumbnail synchronously (admin waits ~3–5s)
    let thumbnailKey = null;
    let thumbnailWarning = null;
    const thumbStart = Date.now();
    try {
      console.log('[adminHtmlTemplates] generating thumbnail for %s (html=%d bytes, slots=%d)',
        id, Buffer.byteLength(cleanHtml, 'utf8'), Object.keys(manifest.slots || {}).length);
      const thumbBuf = await generateTemplateThumbnail(cleanHtml, manifest);
      thumbnailKey = storage.buildThumbnailKey(id);
      await storage.uploadAdmin(thumbBuf, thumbnailKey, 'image/png');
      console.log('[adminHtmlTemplates] thumbnail generated for %s in %dms (%d bytes)',
        id, Date.now() - thumbStart, thumbBuf.length);
    } catch (thumbErr) {
      console.warn('[adminHtmlTemplates] thumbnail failed for %s after %dms: %s',
        id, Date.now() - thumbStart, thumbErr.message);
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
      if (Buffer.byteLength(html, 'utf8') > 3 * 1024 * 1024) {
        return res.status(400).json({ ok: false, error: 'html must be ≤ 3 MB' });
      }
      try {
        manifest = readSlotManifest(html);
      } catch (err) {
        return res.status(400).json({ ok: false, error: `invalid template-meta: ${err.message}` });
      }

      const cleanHtml = stripScriptTags(html);

      // Overwrite the same R2 key
      await storage.uploadAdmin(Buffer.from(cleanHtml, 'utf8'), htmlKey, 'text/html');

      // Regenerate thumbnail
      const thumbStart = Date.now();
      try {
        console.log('[adminHtmlTemplates] regenerating thumbnail for %s (html=%d bytes, slots=%d)',
          id, Buffer.byteLength(cleanHtml, 'utf8'), Object.keys(manifest.slots || {}).length);
        const thumbBuf = await generateTemplateThumbnail(cleanHtml, manifest);
        thumbnailKey = storage.buildThumbnailKey(id);
        await storage.uploadAdmin(thumbBuf, thumbnailKey, 'image/png');
        console.log('[adminHtmlTemplates] thumbnail regenerated for %s in %dms (%d bytes)',
          id, Date.now() - thumbStart, thumbBuf.length);
      } catch (thumbErr) {
        console.warn('[adminHtmlTemplates] thumbnail regen failed for %s after %dms: %s',
          id, Date.now() - thumbStart, thumbErr.message);
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
    if (err.code === '23503' || (err.message && err.message.includes('RESTRICT'))) {
      return res.status(409).json({ ok: false, error: 'Cannot delete — this template is used in a carousel pack. Remove it from the pack first.' });
    }
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

    const thumbStart = Date.now();
    console.log('[adminHtmlTemplates] regenerate-thumbnail for %s (html=%d bytes, slots=%d)',
      id, htmlBuf.length, Object.keys((manifest && manifest.slots) || {}).length);
    const thumbBuf = await generateTemplateThumbnail(html, manifest);
    const thumbnailKey = storage.buildThumbnailKey(id);
    await storage.uploadAdmin(thumbBuf, thumbnailKey, 'image/png');
    await db.prepare('UPDATE html_templates SET thumbnail_r2_key = ? WHERE id = ?').run(thumbnailKey, id);
    console.log('[adminHtmlTemplates] regenerate-thumbnail done for %s in %dms (%d bytes)',
      id, Date.now() - thumbStart, thumbBuf.length);

    res.json({ ok: true, thumbnail_r2_key: thumbnailKey });
  } catch (err) {
    console.error('[adminHtmlTemplates] regenerate-thumbnail error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /from-image — convert a design image to HTML via Claude Vision
// ---------------------------------------------------------------------------

router.post('/from-image', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'], limit: '10mb' }), async (req, res) => {
  try {
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ ok: false, error: 'Upload an image file (PNG, JPG, WebP, or SVG)' });
    }

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(contentType)) {
      return res.status(400).json({ ok: false, error: 'Unsupported file type. Upload a PNG, JPG, WebP, or SVG.' });
    }

    const instructions = req.headers['x-instructions'] || '';

    console.log('[adminHtmlTemplates] from-image: %d bytes, instructions=%s',
      buffer.length, instructions ? 'yes' : 'none');

    const start = Date.now();
    const { html, manifest } = await generateTemplateFromImage(buffer, { instructions, contentType });
    console.log('[adminHtmlTemplates] from-image: generated in %dms (%d bytes HTML, %d slots)',
      Date.now() - start, html.length, Object.keys(manifest.slots || {}).length);

    res.json({ ok: true, html, manifest });
  } catch (err) {
    console.error('[adminHtmlTemplates] from-image error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

'use strict';

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const sharp    = require('sharp');
const path     = require('path');
const { db }   = require('../db');
const storage  = require('../services/storage');

const MAX_BYTES    = 20 * 1024 * 1024; // 20 MB
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf',
]);

function detectFormat(mimeType, width, height) {
  if (mimeType === 'application/pdf') return 'PDF';
  if (!width || !height) return 'Image';
  const r = width / height;
  if (Math.abs(r - 1.0)    < 0.05) return '1:1';
  if (Math.abs(r - 0.8)    < 0.05) return '4:5';
  if (Math.abs(r - 1.91)   < 0.06) return '1.91:1';
  if (Math.abs(r - 1.778)  < 0.06) return '16:9';
  if (Math.abs(r - 0.5625) < 0.05) return '9:16';
  return `${width}×${height}`;
}

// ---------------------------------------------------------------------------
// GET /api/media  —  list the current user's uploaded files
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const { userId, tenantId } = req;
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  (async () => {
    const files = await db.prepare(`
      SELECT id, filename, mime_type, file_size, width, height, format_tag, url, created_at
      FROM   media_files
      WHERE  user_id = ? AND tenant_id = ?
      ORDER  BY created_at DESC
    `).all(userId, tenantId);

    return res.json({ ok: true, files });
  })().catch(err => res.status(500).json({ ok: false, error: err.message }));
});

// ---------------------------------------------------------------------------
// POST /api/media/upload  —  raw binary body, metadata in headers
//   Headers: X-Filename (URI-encoded), Content-Type (MIME type)
// ---------------------------------------------------------------------------
router.post('/upload', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const { userId, tenantId } = req;
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const mimeType = (req.headers['content-type'] || '').split(';')[0].trim();
  const filename = (() => {
    try { return decodeURIComponent(req.headers['x-filename'] || ''); } catch { return ''; }
  })();

  if (!filename || !mimeType) {
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }
  if (!ALLOWED_MIME.has(mimeType)) {
    return res.status(400).json({ ok: false, error: 'invalid_file_type' });
  }

  const buffer = req.body;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return res.status(400).json({ ok: false, error: 'empty_body' });
  }
  if (buffer.length > MAX_BYTES) {
    return res.status(400).json({ ok: false, error: 'file_too_large' });
  }

  // Detect image dimensions for format tag
  let width = null, height = null;
  if (mimeType.startsWith('image/')) {
    try {
      const meta = await sharp(buffer).metadata();
      width  = meta.width  || null;
      height = meta.height || null;
    } catch { /* non-fatal */ }
  }

  const formatTag  = detectFormat(mimeType, width, height);
  const rawExt     = path.extname(filename).toLowerCase() || (mimeType === 'application/pdf' ? '.pdf' : '.bin');
  const storedName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${rawExt}`;
  const url        = `/uploads/${storedName}`;

  await storage.upload(buffer, { tenantId, userId, type: 'uploads', filename: storedName, mimeType });

  const row = await db.prepare(`
    INSERT INTO media_files
      (user_id, tenant_id, filename, stored_name, mime_type, file_size, width, height, format_tag, url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).run(userId, tenantId, filename, storedName, mimeType, buffer.length, width, height, formatTag, url);

  return res.json({
    ok: true,
    file: {
      id: row.lastInsertRowid,
      filename,
      mime_type:  mimeType,
      file_size:  buffer.length,
      width,
      height,
      format_tag: formatTag,
      url,
      created_at: new Date().toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/media/save-generated  —  copy a generated visual into the permanent library
// Body (JSON): { fileUrl: '/files/xxx.png', filename: 'quote_card.png', mimeType: 'image/png' }
// ---------------------------------------------------------------------------
router.post('/save-generated', async (req, res) => {
  const { userId, tenantId } = req;
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const { fileUrl, filename, mimeType } = req.body || {};
  if (!fileUrl || !filename || !mimeType) {
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }

  // fileUrl must start with /files/ and contain only a bare filename
  if (!fileUrl.startsWith('/files/')) {
    return res.status(400).json({ ok: false, error: 'invalid_file_url' });
  }
  const relativeName = fileUrl.slice('/files/'.length);
  if (relativeName.includes('..') || relativeName.includes('/') || relativeName.includes('\0')) {
    return res.status(400).json({ ok: false, error: 'invalid_file_url' });
  }

  const srcKey = storage.buildMemberKey(tenantId, userId, 'generated', relativeName);

  let buffer;
  try {
    buffer = await storage.download(srcKey);
  } catch {
    return res.status(404).json({ ok: false, error: 'source_file_not_found' });
  }

  let width = null, height = null;
  if (mimeType.startsWith('image/')) {
    try {
      const meta = await sharp(buffer).metadata();
      width  = meta.width  || null;
      height = meta.height || null;
    } catch { /* non-fatal */ }
  }

  const formatTag  = detectFormat(mimeType, width, height);
  const ext        = path.extname(filename).toLowerCase() || '.bin';
  const storedName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
  const url        = `/uploads/${storedName}`;

  const dstKey = storage.buildMemberKey(tenantId, userId, 'uploads', storedName);
  await storage.uploadToKey(buffer, dstKey, mimeType);

  const row = await db.prepare(`
    INSERT INTO media_files
      (user_id, tenant_id, filename, stored_name, mime_type, file_size, width, height, format_tag, url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).run(userId, tenantId, filename, storedName, mimeType, buffer.length, width, height, formatTag, url);

  return res.json({
    ok: true,
    file: {
      id:         row.lastInsertRowid,
      filename,
      mime_type:  mimeType,
      file_size:  buffer.length,
      width,
      height,
      format_tag: formatTag,
      url,
      created_at: new Date().toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/media/:id  —  remove a file (storage + DB)
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  const { userId, tenantId } = req;
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const file = await db.prepare(
    'SELECT id, stored_name FROM media_files WHERE id = ? AND user_id = ? AND tenant_id = ?'
  ).get(req.params.id, userId, tenantId);

  if (!file) return res.status(404).json({ ok: false, error: 'not_found' });

  await storage.delete(storage.buildMemberKey(tenantId, userId, 'uploads', file.stored_name));
  await db.prepare('DELETE FROM media_files WHERE id = ? AND user_id = ? AND tenant_id = ?').run(file.id, userId, tenantId);

  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/media/remove-bg
// Raw binary body; proxies to Hugging Face briaai/RMBG-1.4, stores result PNG.
// Returns { ok, pngDataUrl, file } on success or { ok: false, error } on failure.
// ---------------------------------------------------------------------------
router.post('/remove-bg', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const { userId, tenantId } = req;
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const buffer = req.body;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0)
    return res.status(400).json({ ok: false, error: 'empty_body' });

  const hfToken = process.env.HF_TOKEN;
  if (!hfToken) return res.status(503).json({ ok: false, error: 'bg_removal_not_configured' });

  const mimeType = (req.headers['content-type'] || 'image/jpeg').split(';')[0].trim();

  let pngBuffer;
  try {
    const hfRes = await fetch(
      'https://api-inference.huggingface.co/models/briaai/RMBG-1.4',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${hfToken}`, 'Content-Type': mimeType },
        body: buffer,
        signal: AbortSignal.timeout(60_000),
      }
    );
    if (!hfRes.ok) {
      const msg = await hfRes.text().catch(() => '');
      return res.status(502).json({ ok: false, error: `hf_api: ${msg.slice(0, 200)}` });
    }
    pngBuffer = Buffer.from(await hfRes.arrayBuffer());
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }

  let width = null, height = null;
  try {
    const meta = await sharp(pngBuffer).metadata();
    width = meta.width || null;
    height = meta.height || null;
  } catch { /* non-fatal */ }

  const storedName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}_nobg.png`;
  const url        = `/uploads/${storedName}`;

  await storage.upload(pngBuffer, {
    tenantId, userId, type: 'uploads', filename: storedName, mimeType: 'image/png',
  });

  await db.prepare(`
    INSERT INTO media_files
      (user_id, tenant_id, filename, stored_name, mime_type, file_size, width, height, format_tag, url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, tenantId, storedName, storedName, 'image/png',
         pngBuffer.length, width, height, 'nobg', url);

  const pngDataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`;
  return res.json({ ok: true, pngDataUrl, file: { url } });
});

// ---------------------------------------------------------------------------
// Stock Photos (Pexels) & Icons (Iconify) — server-side proxy
// ---------------------------------------------------------------------------
const { getSetting } = require('../db');

async function getPexelsKey() {
  return (process.env.PEXELS_API_KEY || '').trim() || (await getSetting('pexels_api_key'));
}

router.get('/stock/photos', async (req, res) => {
  try {
    const apiKey = await getPexelsKey();
    if (!apiKey) return res.json({ ok: false, error: 'pexels_not_configured' });

    const q       = (req.query.q || '').trim();
    const page    = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = Math.min(30, Math.max(1, parseInt(req.query.per_page) || 15));

    const url = q
      ? `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=${perPage}&page=${page}`
      : `https://api.pexels.com/v1/curated?per_page=${perPage}&page=${page}`;

    const r = await fetch(url, { headers: { Authorization: apiKey } });
    if (!r.ok) return res.status(r.status).json({ ok: false, error: `Pexels API ${r.status}` });

    const data = await r.json();
    const photos = (data.photos || []).map(p => ({
      id:               p.id,
      src_thumb:        p.src.small,
      src_medium:       p.src.medium,
      src_large:        p.src.large2x || p.src.large,
      photographer:     p.photographer,
      photographer_url: p.photographer_url,
      alt:              p.alt || '',
    }));

    return res.json({ ok: true, photos, total_results: data.total_results || 0, page });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/stock/photos/download', express.json(), async (req, res) => {
  try {
    const apiKey = await getPexelsKey();
    if (!apiKey) return res.status(400).json({ ok: false, error: 'pexels_not_configured' });

    const { src_url, photographer, photographer_url } = req.body;
    if (!src_url) return res.status(400).json({ ok: false, error: 'src_url required' });

    const userId   = req.headers['x-user-id']   || 'anon';
    const tenantId = req.headers['x-tenant-id'] || null;

    const imgRes = await fetch(src_url);
    if (!imgRes.ok) return res.status(502).json({ ok: false, error: 'Failed to download image' });

    const buffer   = Buffer.from(await imgRes.arrayBuffer());
    const meta     = await sharp(buffer).metadata();
    const mimeType = `image/${meta.format === 'jpg' ? 'jpeg' : meta.format || 'jpeg'}`;

    const storedName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}_pexels.${meta.format || 'jpg'}`;
    const url        = `/uploads/${storedName}`;

    await storage.upload(buffer, {
      tenantId, userId, type: 'uploads', filename: storedName, mimeType,
    });

    await db.prepare(`
      INSERT INTO media_files
        (user_id, tenant_id, filename, stored_name, mime_type, file_size, width, height, format_tag, url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, tenantId, storedName, storedName, mimeType,
           buffer.length, meta.width || null, meta.height || null, 'stock', url);

    const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
    return res.json({
      ok: true,
      file: { url, storageKey: storedName, dataUrl },
      attribution: { photographer, photographer_url, source: 'pexels' },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/stock/icons', async (req, res) => {
  try {
    const q     = (req.query.q || '').trim();
    if (!q) return res.json({ ok: true, icons: [] });

    const limit = Math.min(64, Math.max(1, parseInt(req.query.limit) || 32));

    const r = await fetch(`https://api.iconify.design/search?query=${encodeURIComponent(q)}&limit=${limit}`);
    if (!r.ok) return res.status(r.status).json({ ok: false, error: `Iconify API ${r.status}` });

    const data = await r.json();
    const icons = (data.icons || []).map(name => {
      const [prefix, ...rest] = name.split(':');
      return { prefix, name: rest.join(':'), fullName: name };
    });

    return res.json({ ok: true, icons, total: data.total || icons.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/stock/icons/download', express.json(), async (req, res) => {
  try {
    const { prefix, name } = req.body;
    if (!prefix || !name) return res.status(400).json({ ok: false, error: 'prefix and name required' });

    const userId   = req.headers['x-user-id']   || 'anon';
    const tenantId = req.headers['x-tenant-id'] || null;

    const svgRes = await fetch(`https://api.iconify.design/${prefix}/${name}.svg?width=512&height=512`);
    if (!svgRes.ok) return res.status(502).json({ ok: false, error: 'Failed to fetch icon SVG' });

    const svgText = await svgRes.text();
    const pngBuffer = await sharp(Buffer.from(svgText))
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    const storedName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}_icon.png`;
    const url        = `/uploads/${storedName}`;

    await storage.upload(pngBuffer, {
      tenantId, userId, type: 'uploads', filename: storedName, mimeType: 'image/png',
    });

    await db.prepare(`
      INSERT INTO media_files
        (user_id, tenant_id, filename, stored_name, mime_type, file_size, width, height, format_tag, url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, tenantId, storedName, storedName, 'image/png',
           pngBuffer.length, 512, 512, 'icon', url);

    const dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`;
    return res.json({ ok: true, file: { url, storageKey: storedName, dataUrl } });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

'use strict';

const express  = require('express');
const router   = express.Router();
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const sharp    = require('sharp');
const { db }   = require('../db');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const MAX_BYTES    = 20 * 1024 * 1024; // 20 MB original
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

  const files = db.prepare(`
    SELECT id, filename, mime_type, file_size, width, height, format_tag, url, created_at
    FROM   media_files
    WHERE  user_id = ? AND tenant_id = ?
    ORDER  BY created_at DESC
  `).all(userId, tenantId);

  return res.json({ ok: true, files });
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
  const filePath   = path.join(UPLOADS_DIR, storedName);
  const url        = `/uploads/${storedName}`;

  fs.writeFileSync(filePath, buffer);

  const row = db.prepare(`
    INSERT INTO media_files
      (user_id, tenant_id, filename, stored_name, mime_type, file_size, width, height, format_tag, url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
const GENERATED_DIR = path.join(__dirname, '..', 'generated');

router.post('/save-generated', async (req, res) => {
  const { userId, tenantId } = req;
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const { fileUrl, filename, mimeType } = req.body || {};
  if (!fileUrl || !filename || !mimeType) {
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }

  // Resolve to local path — fileUrl must start with /files/
  if (!fileUrl.startsWith('/files/')) {
    return res.status(400).json({ ok: false, error: 'invalid_file_url' });
  }
  const relativeName = fileUrl.slice('/files/'.length);
  // Prevent path traversal
  if (relativeName.includes('..') || relativeName.includes('/') || relativeName.includes('\0')) {
    return res.status(400).json({ ok: false, error: 'invalid_file_url' });
  }

  const srcPath = path.join(GENERATED_DIR, relativeName);
  let buffer;
  try {
    buffer = fs.readFileSync(srcPath);
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
  const destPath   = path.join(UPLOADS_DIR, storedName);
  const url        = `/uploads/${storedName}`;

  fs.copyFileSync(srcPath, destPath);

  const row = db.prepare(`
    INSERT INTO media_files
      (user_id, tenant_id, filename, stored_name, mime_type, file_size, width, height, format_tag, url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
// DELETE /api/media/:id  —  remove a file (disk + DB)
// ---------------------------------------------------------------------------
router.delete('/:id', (req, res) => {
  const { userId, tenantId } = req;
  if (!userId) return res.status(400).json({ ok: false, error: 'missing_user_id' });

  const file = db.prepare(
    'SELECT id, stored_name FROM media_files WHERE id = ? AND user_id = ? AND tenant_id = ?'
  ).get(req.params.id, userId, tenantId);

  if (!file) return res.status(404).json({ ok: false, error: 'not_found' });

  try { fs.unlinkSync(path.join(UPLOADS_DIR, file.stored_name)); } catch { /* already gone */ }
  db.prepare('DELETE FROM media_files WHERE id = ?').run(file.id);

  return res.json({ ok: true });
});

module.exports = router;

'use strict';

/**
 * Storage abstraction — local disk (dev) or Cloudflare R2 (production).
 *
 * Key hierarchy:
 *   workspaces/{workspaceId}/members/{userId}/uploads/{filename}
 *   workspaces/{workspaceId}/members/{userId}/generated/{filename}
 *   workspaces/{workspaceId}/shared/{filename}    ← workspace brand assets
 *   workspaces/{workspaceId}/vault/{filename}      ← workspace vault docs
 *   affiliates/{userId}/{filename}
 *   global/templates/{uuid}.html                  ← admin HTML templates
 *   global/thumbnails/{uuid}.png
 *
 * Environment variables:
 *   STORAGE_BACKEND       'local' (default) | 's3'
 *   R2_ENDPOINT           https://<account-id>.r2.cloudflarestorage.com
 *   R2_BUCKET_NAME        bucket name
 *   R2_ACCESS_KEY_ID      R2 API token key
 *   R2_SECRET_ACCESS_KEY  R2 API token secret
 *   R2_KEY_PREFIX         optional prefix, e.g. 'prod/'
 */

const fs   = require('fs');
const path = require('path');

const BACKEND = (process.env.STORAGE_BACKEND || 'local').toLowerCase();

if (process.env.R2_BUCKET_NAME && BACKEND !== 's3') {
  console.warn('[storage] R2_BUCKET_NAME is set but STORAGE_BACKEND is not "s3" — using local disk.');
}

const LOCAL_UPLOADS_DIR   = path.join(__dirname, '..', 'uploads');
const LOCAL_GENERATED_DIR = path.join(__dirname, '..', 'generated');
const LOCAL_ADMIN_DIR     = path.join(__dirname, '..', 'uploads', 'admin');

for (const dir of [LOCAL_UPLOADS_DIR, LOCAL_GENERATED_DIR, LOCAL_ADMIN_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// R2 config
// ---------------------------------------------------------------------------

const R2_BUCKET = process.env.R2_BUCKET_NAME || '';
const R2_PREFIX = (process.env.R2_KEY_PREFIX || '').replace(/\/$/, '');

if (BACKEND === 's3') {
  const missing = ['R2_ENDPOINT', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].filter(k => !process.env[k]);
  if (missing.length) throw new Error(`[storage] Missing required R2 env vars: ${missing.join(', ')}`);
}

// ---------------------------------------------------------------------------
// R2 client (lazy)
// ---------------------------------------------------------------------------

let _r2Client = null;

function getR2Client() {
  if (_r2Client) return _r2Client;
  const { S3Client } = require('@aws-sdk/client-s3');
  _r2Client = new S3Client({
    region:      'auto',
    endpoint:    process.env.R2_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return _r2Client;
}

// ---------------------------------------------------------------------------
// Key builders — return full R2 key (prefix already applied)
// ---------------------------------------------------------------------------

function prefixed(key) {
  return R2_PREFIX ? `${R2_PREFIX}/${key}` : key;
}

/** Per-member uploads / generated visuals within a workspace. */
function buildMemberKey(workspaceId, userId, type, filename) {
  return prefixed(`workspaces/${workspaceId}/members/${userId}/${type}/${filename}`);
}

/** Workspace-shared brand assets (logos, BG images) — any member can read. */
function buildWorkspaceAssetKey(workspaceId, filename) {
  return prefixed(`workspaces/${workspaceId}/shared/${filename}`);
}

/** Workspace-level vault documents (not user-siloed). */
function buildVaultKey(workspaceId, filename) {
  return prefixed(`workspaces/${workspaceId}/vault/${filename}`);
}

/** Affiliate-specific storage (no workspace context). */
function buildAffiliateKey(userId, filename) {
  return prefixed(`affiliates/${userId}/${filename}`);
}

/**
 * Admin template key (no prefix — prefix applied by uploadAdmin/downloadAdmin).
 * e.g. buildTemplateKey('uuid') → 'global/templates/uuid.html'
 */
function buildTemplateKey(templateId) {
  return `global/templates/${templateId}.html`;
}

/**
 * Admin thumbnail key (no prefix — prefix applied by uploadAdmin/downloadAdmin).
 * e.g. buildThumbnailKey('uuid') → 'global/thumbnails/uuid.png'
 */
function buildThumbnailKey(templateId) {
  return `global/thumbnails/${templateId}.png`;
}

// ---------------------------------------------------------------------------
// Local path helpers
// ---------------------------------------------------------------------------

function keyToLocalPath(key) {
  const parts = key.split('/');
  const filename = parts[parts.length - 1];
  const type     = parts[parts.length - 2];
  if (type === 'generated') return path.join(LOCAL_GENERATED_DIR, filename);
  return path.join(LOCAL_UPLOADS_DIR, filename);
}

function adminKeyToLocalPath(rawKey) {
  const safeParts = rawKey.split('/').map(p => p.replace(/[^a-zA-Z0-9._-]/g, '_'));
  const dir = path.join(LOCAL_ADMIN_DIR, ...safeParts.slice(0, -1));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, safeParts[safeParts.length - 1]);
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

async function _r2Get(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const resp = await getR2Client().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of resp.Body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return { buffer: Buffer.concat(chunks), contentType: resp.ContentType, contentLength: resp.ContentLength };
}

function _is404(err) {
  return err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
}

function getBackend() {
  return BACKEND === 's3' ? 'r2' : 'local';
}

// ---------------------------------------------------------------------------
// Low-level explicit-key operations
// ---------------------------------------------------------------------------

/**
 * Upload to an explicit full R2 key (key already includes prefix).
 * Use this for vault docs, workspace assets, and any non-member-scoped content.
 */
async function uploadToKey(buffer, key, mimeType) {
  if (BACKEND === 's3') {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await getR2Client().send(new PutObjectCommand({
      Bucket:      R2_BUCKET,
      Key:         key,
      Body:        buffer,
      ContentType: mimeType,
    }));
  } else {
    fs.writeFileSync(keyToLocalPath(key), buffer);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Public user-content API
// ---------------------------------------------------------------------------

/**
 * Upload a buffer to member-scoped storage.
 * @param {Buffer} buffer
 * @param {{ tenantId, userId, type, filename, mimeType }} opts
 * @returns {Promise<string>} The storage key.
 */
async function upload(buffer, { tenantId, userId, type, filename, mimeType }) {
  const key = buildMemberKey(tenantId, userId, type, filename);
  return uploadToKey(buffer, key, mimeType);
}

/**
 * Download a stored object as a Buffer.
 * @param {string} key
 * @returns {Promise<Buffer>}
 */
async function download(key) {
  if (BACKEND === 's3') {
    const { buffer } = await _r2Get(key);
    return buffer;
  } else {
    const localPath = keyToLocalPath(key);
    if (fs.existsSync(localPath)) return fs.readFileSync(localPath);
    const err = new Error('file_not_found');
    err.code = 'ENOENT';
    throw err;
  }
}

/**
 * Delete a stored object.
 * @param {string} key
 * @returns {Promise<void>}
 */
async function remove(key) {
  if (BACKEND === 's3') {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await getR2Client().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } else {
    try { fs.unlinkSync(keyToLocalPath(key)); } catch { /* already gone */ }
  }
}

/**
 * Copy an object within R2.
 * @param {string} srcKey
 * @param {string} dstKey
 * @returns {Promise<void>}
 */
async function copy(srcKey, dstKey) {
  if (BACKEND === 's3') {
    const { CopyObjectCommand } = require('@aws-sdk/client-s3');
    await getR2Client().send(new CopyObjectCommand({
      Bucket:     R2_BUCKET,
      CopySource: `${R2_BUCKET}/${srcKey}`,
      Key:        dstKey,
    }));
  } else {
    const srcPath = keyToLocalPath(srcKey);
    const dstPath = keyToLocalPath(dstKey);
    if (!fs.existsSync(srcPath)) {
      const err = new Error('file_not_found');
      err.code = 'ENOENT';
      throw err;
    }
    fs.copyFileSync(srcPath, dstPath);
  }
}

/**
 * Stream a stored object directly to an HTTP response.
 * @param {string} key
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
async function stream(key, res, next) {
  if (BACKEND === 's3') {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    let resp;
    try {
      resp = await getR2Client().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    } catch (err) {
      if (_is404(err)) return next ? next() : res.status(404).end();
      throw err;
    }
    if (resp.ContentType)   res.setHeader('Content-Type',   resp.ContentType);
    if (resp.ContentLength) res.setHeader('Content-Length', String(resp.ContentLength));
    resp.Body.on('error', () => { if (!res.headersSent) res.status(500).end(); });
    resp.Body.pipe(res);
  } else {
    const localPath = keyToLocalPath(key);
    res.sendFile(localPath, err => { if (err) return next ? next() : res.status(404).end(); });
  }
}

// ---------------------------------------------------------------------------
// Admin raw-key API — for global assets (templates, thumbnails).
// Callers pass the raw key (e.g. 'global/templates/uuid.html'); prefix is added here.
// ---------------------------------------------------------------------------

async function uploadAdmin(buffer, rawKey, mimeType) {
  const fullKey = R2_PREFIX ? `${R2_PREFIX}/${rawKey}` : rawKey;
  if (BACKEND === 's3') {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await getR2Client().send(new PutObjectCommand({
      Bucket:      R2_BUCKET,
      Key:         fullKey,
      Body:        buffer,
      ContentType: mimeType,
    }));
  } else {
    fs.writeFileSync(adminKeyToLocalPath(rawKey), buffer);
  }
  return rawKey;
}

async function downloadAdmin(rawKey) {
  const fullKey = R2_PREFIX ? `${R2_PREFIX}/${rawKey}` : rawKey;
  if (BACKEND === 's3') {
    const { buffer } = await _r2Get(fullKey);
    return buffer;
  } else {
    const localPath = adminKeyToLocalPath(rawKey);
    if (!fs.existsSync(localPath)) {
      const err = new Error('file_not_found');
      err.code = 'ENOENT';
      throw err;
    }
    return fs.readFileSync(localPath);
  }
}

async function removeAdmin(rawKey) {
  const fullKey = R2_PREFIX ? `${R2_PREFIX}/${rawKey}` : rawKey;
  if (BACKEND === 's3') {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await getR2Client().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: fullKey }));
  } else {
    try { fs.unlinkSync(adminKeyToLocalPath(rawKey)); } catch { /* already gone */ }
  }
}

module.exports = {
  // Key builders (full key with prefix)
  buildMemberKey, buildWorkspaceAssetKey, buildVaultKey, buildAffiliateKey,
  // Key builders (raw key, no prefix — for use with uploadAdmin/downloadAdmin)
  buildTemplateKey, buildThumbnailKey,
  // Utilities
  getBackend,
  // User-content API
  upload, uploadToKey, download, delete: remove, copy, stream,
  // Admin API
  uploadAdmin, downloadAdmin, removeAdmin,
};

'use strict';

/**
 * Storage abstraction — local disk, Cloudflare R2 (production), or AWS S3 (staging).
 *
 * Key hierarchy:
 *   workspaces/{workspaceId}/members/{userId}/uploads/{filename}
 *   workspaces/{workspaceId}/members/{userId}/generated/{filename}
 *   workspaces/{workspaceId}/shared/{filename}      ← workspace brand assets
 *   workspaces/{workspaceId}/vault/{filename}        ← workspace vault docs
 *   affiliates/{userId}/{filename}
 *   global/templates/{uuid}.html                    ← admin HTML templates
 *   global/thumbnails/{uuid}.png
 *
 * Legacy path (backward-compat reads):
 *   tenants/{workspaceId}/users/{userId}/{type}/{filename}
 *
 * Environment variables:
 *   STORAGE_BACKEND         'local' (default) | 's3'
 *
 *   R2 (production — takes priority when R2_BUCKET_NAME is set):
 *   R2_ENDPOINT             https://<account-id>.r2.cloudflarestorage.com
 *   R2_BUCKET_NAME          bucket name
 *   R2_ACCESS_KEY_ID        R2 API token key
 *   R2_SECRET_ACCESS_KEY    R2 API token secret
 *   R2_KEY_PREFIX           optional prefix, e.g. 'prod/'
 *
 *   S3 (staging / fallback):
 *   S3_BUCKET_NAME          bucket name
 *   S3_REGION               default: us-east-1
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 *   S3_ENDPOINT             optional custom endpoint for MinIO/LocalStack
 *   S3_KEY_PREFIX           optional prefix, e.g. 'staging/'
 */

const fs   = require('fs');
const path = require('path');

const BACKEND = (process.env.STORAGE_BACKEND || 'local').toLowerCase();

const LOCAL_UPLOADS_DIR   = path.join(__dirname, '..', 'uploads');
const LOCAL_GENERATED_DIR = path.join(__dirname, '..', 'generated');
const LOCAL_ADMIN_DIR     = path.join(__dirname, '..', 'uploads', 'admin');

for (const dir of [LOCAL_UPLOADS_DIR, LOCAL_GENERATED_DIR, LOCAL_ADMIN_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Dual-environment config: R2 (production) takes priority over S3 (staging)
// ---------------------------------------------------------------------------

function resolveStorageConfig() {
  if (process.env.R2_BUCKET_NAME) {
    return {
      endpoint:    process.env.R2_ENDPOINT,
      region:      'auto',
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
      bucket: process.env.R2_BUCKET_NAME,
      prefix: (process.env.R2_KEY_PREFIX || '').replace(/\/$/, ''),
    };
  }
  return {
    endpoint:       process.env.S3_ENDPOINT || undefined,
    region:         process.env.S3_REGION || 'us-east-1',
    forcePathStyle: !!process.env.S3_ENDPOINT,
    bucket:         process.env.S3_BUCKET_NAME || '',
    prefix:         (process.env.S3_KEY_PREFIX || '').replace(/\/$/, ''),
  };
}

const STORAGE_CONFIG = resolveStorageConfig();
const S3_BUCKET = STORAGE_CONFIG.bucket;
const S3_PREFIX = STORAGE_CONFIG.prefix;

// ---------------------------------------------------------------------------
// S3/R2 client (lazy)
// ---------------------------------------------------------------------------

let _s3Client = null;

function getS3Client() {
  if (_s3Client) return _s3Client;
  const { S3Client } = require('@aws-sdk/client-s3');
  const cfg = {
    region: STORAGE_CONFIG.region,
  };
  if (STORAGE_CONFIG.credentials) cfg.credentials = STORAGE_CONFIG.credentials;
  if (STORAGE_CONFIG.endpoint) {
    cfg.endpoint       = STORAGE_CONFIG.endpoint;
    cfg.forcePathStyle = STORAGE_CONFIG.forcePathStyle;
  }
  _s3Client = new S3Client(cfg);
  return _s3Client;
}

// ---------------------------------------------------------------------------
// Key builders — return full S3 key (prefix already applied)
// ---------------------------------------------------------------------------

function prefixed(key) {
  return S3_PREFIX ? `${S3_PREFIX}/${key}` : key;
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

/** Legacy path for backward-compat reads of pre-migration files. */
function buildLegacyKey(workspaceId, userId, type, filename) {
  return prefixed(`tenants/${workspaceId}/users/${userId}/${type}/${filename}`);
}

/** @deprecated Use buildMemberKey. Kept as alias during migration. */
function buildKey(workspaceId, userId, type, filename) {
  return buildMemberKey(workspaceId, userId, type, filename);
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
  const type     = parts[parts.length - 2]; // 'uploads'|'generated'|'vault'|'shared'|...
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

async function _s3Get(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const resp = await getS3Client().send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
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
  return BACKEND === 's3' ? 's3' : 'local';
}

// ---------------------------------------------------------------------------
// Low-level explicit-key operations
// ---------------------------------------------------------------------------

/**
 * Upload to an explicit full S3 key (key already includes prefix).
 * Use this for vault docs, workspace assets, and any non-member-scoped content.
 */
async function uploadToKey(buffer, key, mimeType) {
  if (BACKEND === 's3') {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await getS3Client().send(new PutObjectCommand({
      Bucket:      S3_BUCKET,
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
 * If legacyKey is provided, falls back to it on 404 (supports pre-migration files).
 * @param {string} key
 * @param {string|null} [legacyKey]
 * @returns {Promise<Buffer>}
 */
async function download(key, legacyKey = null) {
  if (BACKEND === 's3') {
    try {
      const { buffer } = await _s3Get(key);
      return buffer;
    } catch (err) {
      if (legacyKey && _is404(err)) {
        const { buffer } = await _s3Get(legacyKey);
        return buffer;
      }
      throw err;
    }
  } else {
    const localPath = keyToLocalPath(key);
    if (fs.existsSync(localPath)) return fs.readFileSync(localPath);
    if (legacyKey) {
      const legacyPath = keyToLocalPath(legacyKey);
      if (fs.existsSync(legacyPath)) return fs.readFileSync(legacyPath);
    }
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
    await getS3Client().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  } else {
    try { fs.unlinkSync(keyToLocalPath(key)); } catch { /* already gone */ }
  }
}

/**
 * Copy an object within the same storage backend.
 * @param {string} srcKey
 * @param {string} dstKey
 * @returns {Promise<void>}
 */
async function copy(srcKey, dstKey) {
  if (BACKEND === 's3') {
    const { CopyObjectCommand } = require('@aws-sdk/client-s3');
    await getS3Client().send(new CopyObjectCommand({
      Bucket:     S3_BUCKET,
      CopySource: `${S3_BUCKET}/${srcKey}`,
      Key:        dstKey,
    }));
  } else {
    const srcPath = keyToLocalPath(srcKey);
    const dstPath = keyToLocalPath(dstKey);
    fs.copyFileSync(srcPath, dstPath);
  }
}

/**
 * Stream a stored object directly to an HTTP response.
 * Falls back to legacyKey on 404 (supports pre-migration files).
 * @param {string} key
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @param {string|null} [legacyKey]
 * @returns {Promise<void>}
 */
async function stream(key, res, next, legacyKey = null) {
  if (BACKEND === 's3') {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    let resp;
    try {
      resp = await getS3Client().send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    } catch (err) {
      if (_is404(err) && legacyKey) {
        try {
          resp = await getS3Client().send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: legacyKey }));
        } catch {
          return next ? next() : res.status(404).end();
        }
      } else if (_is404(err)) {
        return next ? next() : res.status(404).end();
      } else {
        throw err;
      }
    }
    if (resp.ContentType)   res.setHeader('Content-Type',   resp.ContentType);
    if (resp.ContentLength) res.setHeader('Content-Length', String(resp.ContentLength));
    resp.Body.pipe(res);
  } else {
    const localPath = keyToLocalPath(key);
    if (fs.existsSync(localPath)) {
      return res.sendFile(localPath, err => { if (err) return next ? next() : res.status(404).end(); });
    }
    if (legacyKey) {
      const legacyPath = keyToLocalPath(legacyKey);
      return res.sendFile(legacyPath, err => { if (err) return next ? next() : res.status(404).end(); });
    }
    return next ? next() : res.status(404).end();
  }
}

// ---------------------------------------------------------------------------
// Admin raw-key API — for global assets (templates, thumbnails).
// Callers pass the raw key (e.g. 'global/templates/uuid.html'); prefix is added here.
// ---------------------------------------------------------------------------

async function uploadAdmin(buffer, rawKey, mimeType) {
  const fullKey = S3_PREFIX ? `${S3_PREFIX}/${rawKey}` : rawKey;
  if (BACKEND === 's3') {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await getS3Client().send(new PutObjectCommand({
      Bucket:      S3_BUCKET,
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
  const fullKey = S3_PREFIX ? `${S3_PREFIX}/${rawKey}` : rawKey;
  if (BACKEND === 's3') {
    const { buffer } = await _s3Get(fullKey);
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
  const fullKey = S3_PREFIX ? `${S3_PREFIX}/${rawKey}` : rawKey;
  if (BACKEND === 's3') {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await getS3Client().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: fullKey }));
  } else {
    try { fs.unlinkSync(adminKeyToLocalPath(rawKey)); } catch { /* already gone */ }
  }
}

module.exports = {
  // Key builders (full key with prefix)
  buildKey, buildMemberKey, buildWorkspaceAssetKey,
  buildVaultKey, buildAffiliateKey, buildLegacyKey,
  // Key builders (raw key, no prefix — for use with uploadAdmin/downloadAdmin)
  buildTemplateKey, buildThumbnailKey,
  // Utilities
  getBackend,
  // User-content API
  upload, uploadToKey, download, delete: remove, copy, stream,
  // Admin API
  uploadAdmin, downloadAdmin, removeAdmin,
};

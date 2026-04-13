'use strict';

/**
 * Storage abstraction — local disk or Amazon S3.
 *
 * S3 key structure (per-tenant isolation):
 *   {S3_KEY_PREFIX}tenants/{tenant_id}/users/{user_id}/{type}/{filename}
 *   type = 'uploads' | 'generated'
 *
 * Environment variables:
 *   STORAGE_BACKEND       'local' (default) | 's3'
 *   S3_BUCKET_NAME        required for s3
 *   S3_REGION             required for s3 (default: us-east-1)
 *   AWS_ACCESS_KEY_ID     required for s3
 *   AWS_SECRET_ACCESS_KEY required for s3
 *   S3_KEY_PREFIX         optional prefix, e.g. 'dev/' or 'prod/'
 *   S3_ENDPOINT           optional custom endpoint (MinIO, LocalStack)
 */

const fs   = require('fs');
const path = require('path');

const BACKEND = (process.env.STORAGE_BACKEND || 'local').toLowerCase();

const LOCAL_UPLOADS_DIR   = path.join(__dirname, '..', 'uploads');
const LOCAL_GENERATED_DIR = path.join(__dirname, '..', 'generated');

// Ensure local dirs exist (no-op in s3 mode but harmless)
if (!fs.existsSync(LOCAL_UPLOADS_DIR))   fs.mkdirSync(LOCAL_UPLOADS_DIR,   { recursive: true });
if (!fs.existsSync(LOCAL_GENERATED_DIR)) fs.mkdirSync(LOCAL_GENERATED_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// S3 client (lazy — only created when backend === 's3')
// ---------------------------------------------------------------------------

let _s3Client = null;

function getS3Client() {
  if (_s3Client) return _s3Client;
  const { S3Client } = require('@aws-sdk/client-s3');
  const config = {
    region: process.env.S3_REGION || 'us-east-1',
  };
  if (process.env.S3_ENDPOINT) {
    config.endpoint = process.env.S3_ENDPOINT;
    config.forcePathStyle = true; // required for MinIO / LocalStack
  }
  _s3Client = new S3Client(config);
  return _s3Client;
}

const S3_BUCKET = process.env.S3_BUCKET_NAME || '';
const S3_PREFIX = (process.env.S3_KEY_PREFIX || '').replace(/\/$/, ''); // strip trailing slash

// ---------------------------------------------------------------------------
// Key / path helpers
// ---------------------------------------------------------------------------

/**
 * Build an S3 object key for a given tenant, user, storage type, and filename.
 * @param {string} tenantId
 * @param {string} userId
 * @param {'uploads'|'generated'} type
 * @param {string} filename  — bare filename only, no path separators
 * @returns {string}
 */
function buildKey(tenantId, userId, type, filename) {
  const parts = [S3_PREFIX, `tenants/${tenantId}/users/${userId}/${type}/${filename}`]
    .filter(Boolean);
  return parts.join('/');
}

/**
 * Resolve a storage key to a local filesystem path.
 * Only used by the local backend.
 */
function keyToLocalPath(key) {
  // Key format: [prefix/]tenants/{t}/users/{u}/{type}/{filename}
  // We only care about type + filename for local storage.
  const parts = key.split('/');
  const filename = parts[parts.length - 1];
  const type     = parts[parts.length - 2]; // 'uploads' | 'generated'
  const dir = type === 'uploads' ? LOCAL_UPLOADS_DIR : LOCAL_GENERATED_DIR;
  return path.join(dir, filename);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @returns {'local'|'s3'}
 */
function getBackend() {
  return BACKEND === 's3' ? 's3' : 'local';
}

/**
 * Upload a buffer to storage.
 * @param {Buffer} buffer
 * @param {{ tenantId: string, userId: string, type: 'uploads'|'generated', filename: string, mimeType: string }} opts
 * @returns {Promise<string>} The storage key.
 */
async function upload(buffer, { tenantId, userId, type, filename, mimeType }) {
  const key = buildKey(tenantId, userId, type, filename);

  if (BACKEND === 's3') {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await getS3Client().send(new PutObjectCommand({
      Bucket:      S3_BUCKET,
      Key:         key,
      Body:        buffer,
      ContentType: mimeType,
    }));
  } else {
    const localPath = keyToLocalPath(key);
    fs.writeFileSync(localPath, buffer);
  }

  return key;
}

/**
 * Download a stored object as a Buffer.
 * @param {string} key
 * @returns {Promise<Buffer>}
 */
async function download(key) {
  if (BACKEND === 's3') {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const resp = await getS3Client().send(new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key:    key,
    }));
    // resp.Body is a ReadableStream (Node.js)
    const chunks = [];
    for await (const chunk of resp.Body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } else {
    const localPath = keyToLocalPath(key);
    if (!fs.existsSync(localPath)) {
      const err = new Error('file_not_found');
      err.code = 'ENOENT';
      throw err;
    }
    return fs.readFileSync(localPath);
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
    await getS3Client().send(new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key:    key,
    }));
  } else {
    const localPath = keyToLocalPath(key);
    try { fs.unlinkSync(localPath); } catch { /* already gone */ }
  }
}

/**
 * Copy an object within the same storage backend.
 * Used by save-generated: copies generated/ → uploads/.
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
 * Sets Content-Type from S3 metadata (S3 mode) or via res.sendFile (local mode).
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
      resp = await getS3Client().send(new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key:    key,
      }));
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return next ? next() : res.status(404).end();
      }
      throw err;
    }

    if (resp.ContentType) res.setHeader('Content-Type', resp.ContentType);
    if (resp.ContentLength) res.setHeader('Content-Length', String(resp.ContentLength));
    resp.Body.pipe(res);
  } else {
    const localPath = keyToLocalPath(key);
    res.sendFile(localPath, err => {
      if (err) return next ? next() : res.status(404).end();
    });
  }
}

module.exports = { buildKey, getBackend, upload, download, delete: remove, copy, stream };

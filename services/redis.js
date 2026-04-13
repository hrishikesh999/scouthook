'use strict';

/**
 * Shared Redis client — lazily initialized, gracefully absent.
 *
 * Other modules call getRedis() to get the client. If Redis is not configured
 * or the connection fails, getRedis() returns null and callers fall back to
 * in-process behavior (acceptable on a single instance; required for multi-instance).
 */

const { getSetting } = require('../db');

let client = null;
let initialized = false;

/**
 * Initialize the Redis client from env or platform_settings.
 * Called once from server.js after the scheduler is initialized.
 */
async function initRedis() {
  if (initialized) return;
  initialized = true;

  const redisUrl = (process.env.REDIS_URL || '').trim() || (await getSetting('redis_url'));
  if (!redisUrl) return; // Redis not configured — all callers fall back to in-memory

  try {
    const IORedis = require('ioredis');
    const c = new IORedis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    await c.connect();
    client = c;
    console.log('[redis] shared client connected');
  } catch (err) {
    console.warn('[redis] could not connect shared client:', err.message);
  }
}

/** Returns the Redis client, or null if Redis is unavailable. */
function getRedis() {
  return client;
}

/**
 * Set a key with a TTL (seconds).
 * Returns false if Redis is unavailable.
 */
async function redisSet(key, value, ttlSeconds) {
  if (!client) return false;
  try {
    await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a key. Returns null if Redis is unavailable or key doesn't exist.
 */
async function redisGet(key) {
  if (!client) return null;
  try {
    const raw = await client.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Delete a key.
 */
async function redisDel(key) {
  if (!client) return;
  try {
    await client.del(key);
  } catch { /* non-fatal */ }
}

module.exports = { initRedis, getRedis, redisSet, redisGet, redisDel };

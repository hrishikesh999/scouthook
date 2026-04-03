'use strict';

const { getSetting } = require('../db');

let postQueue = null;

/**
 * Initialise BullMQ queue and worker.
 * Only starts if redis_url is configured in platform_settings.
 * Called from server.js on startup — failure is non-fatal (logged as warning).
 */
async function initScheduler() {
  const redisUrl = getSetting('redis_url');
  if (!redisUrl) {
    console.warn('[scheduler] redis_url not set in platform_settings — scheduling disabled');
    return;
  }

  const { Queue, Worker } = require('bullmq');
  const IORedis = require('ioredis');
  const { publishScheduledPost } = require('./linkedinPublisher');

  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  postQueue = new Queue('linkedin-posts', { connection });

  const worker = new Worker('linkedin-posts', async job => {
    const { scheduledPostId } = job.data;
    await publishScheduledPost(scheduledPostId);
  }, {
    connection,
    concurrency: 5,
  });

  worker.on('failed', (job, err) => {
    console.error(`[scheduler] Job ${job?.id} failed after ${job?.attemptsMade} attempts:`, err.message);
  });

  worker.on('completed', job => {
    console.log(`[scheduler] Job ${job.id} completed (scheduledPostId=${job.data.scheduledPostId})`);
  });

  console.log('[scheduler] BullMQ queue and worker started on', redisUrl);

  // Re-enqueue any pending scheduled posts whose BullMQ jobs were lost (e.g. server restart)
  const { db } = require('../db');
  const pending = db.prepare(
    "SELECT id, scheduled_for FROM scheduled_posts WHERE status = 'pending'"
  ).all();

  for (const row of pending) {
    const scheduledFor = new Date(row.scheduled_for);
    const delay = Math.max(0, scheduledFor.getTime() - Date.now()); // 0 = fire immediately if past-due
    await postQueue.add('publish', { scheduledPostId: row.id }, {
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
    console.log(`[scheduler] Re-enqueued scheduledPostId=${row.id} delay=${delay}ms`);
  }
}

/**
 * Add a delayed job to publish a scheduled post.
 * @param {number} scheduledPostId — row id in scheduled_posts table
 * @param {Date} scheduledFor — when to fire the job
 * @returns {Promise<string>} BullMQ job id
 */
async function addScheduledJob(scheduledPostId, scheduledFor) {
  if (!postQueue) throw new Error('scheduler_not_initialized — redis_url may not be configured');

  const { Queue } = require('bullmq');
  const delay = Math.max(0, scheduledFor.getTime() - Date.now());

  const job = await postQueue.add(
    'publish',
    { scheduledPostId },
    {
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    }
  );

  return job.id;
}

/**
 * Remove a pending BullMQ job for a scheduled post (on cancellation).
 * No-op if scheduler is disabled or job has already fired.
 * @param {number} scheduledPostId
 */
async function removeScheduledJob(scheduledPostId) {
  if (!postQueue) return;

  try {
    const delayed = await postQueue.getDelayed();
    const job = delayed.find(j => j.data.scheduledPostId === scheduledPostId);
    if (job) await job.remove();
  } catch (err) {
    // Non-fatal — job may have already fired
    console.warn('[scheduler] Could not remove job for scheduledPostId', scheduledPostId, '—', err.message);
  }
}

module.exports = { initScheduler, addScheduledJob, removeScheduledJob };

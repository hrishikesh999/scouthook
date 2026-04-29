'use strict';

const { getSetting, db, backendKind } = require('../db');
const { sendEmailToUser } = require('../emails');

let postQueue = null;
let workerInstance = null;
let schedulerEnabled = false;
let schedulingEnabledCache = true;

/** BullMQ disallows ':' in custom job ids. */
function scheduledJobId(scheduledPostId) {
  return `scheduled-${scheduledPostId}`;
}

/**
 * Recover posts stuck in 'processing' for >20 minutes (e.g. worker crash).
 * Marks them not_sent, reverts associated drafts, and sends notifications.
 * Called at startup and every 10 minutes by a periodic timer.
 */
async function recoverStuckPosts() {
  const stuckSql = backendKind === 'sqlite'
    ? `SELECT id, scheduled_for FROM scheduled_posts WHERE status = 'processing' AND updated_at < datetime('now', '-20 minutes')`
    : `SELECT id, scheduled_for FROM scheduled_posts WHERE status = 'processing' AND updated_at < (now() - interval '20 minutes')`;
  const stuck = await db.prepare(stuckSql).all();

  for (const row of stuck) {
    await db.prepare(`
      UPDATE scheduled_posts
      SET status = 'not_sent',
          error_message = 'stuck_processing_timeout',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'processing'
    `).run(row.id);

    try {
      const meta = await db.prepare(
        'SELECT user_id, tenant_id, post_id, content, scheduled_for FROM scheduled_posts WHERE id = ?'
      ).get(row.id);
      if (meta) {
        if (meta.post_id) {
          await db.prepare(`
            UPDATE generated_posts SET status = 'draft'
            WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'scheduled'
          `).run(meta.post_id, meta.user_id, meta.tenant_id);
        }

        await db.prepare(`
          INSERT INTO scheduled_post_events (scheduled_post_id, user_id, tenant_id, event_type, message)
          VALUES (?, ?, ?, 'recovered', ?)
        `).run(row.id, meta.user_id, meta.tenant_id, 'processing_stale→not_sent');

        await db.prepare(`
          INSERT INTO notifications (user_id, tenant_id, type, title, body, ref_id, ref_type)
          VALUES (?, ?, 'publish_failed', 'Scheduled post failed', ?, ?, 'scheduled_post')
        `).run(
          meta.user_id, meta.tenant_id,
          'Your scheduled post could not be published: stuck_processing_timeout',
          row.id
        );

        const appUrl = process.env.APP_URL || '';
        const postPreview = (meta.content || '').slice(0, 120) + ((meta.content || '').length > 120 ? '…' : '');
        const scheduledFor = meta.scheduled_for
          ? new Date(meta.scheduled_for).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
          : 'the scheduled time';
        sendEmailToUser(meta.user_id, meta.tenant_id, 'post-failed', {
          scheduled_for: scheduledFor,
          error_reason: 'The post worker timed out. Please reschedule.',
          post_preview: postPreview,
          app_url: appUrl,
        }, { dedupKey: false }).catch(() => {});
      }
    } catch { /* non-fatal */ }

    console.log(`[scheduler] Recovered processing→not_sent scheduledPostId=${row.id}`);
  }
}

/**
 * Initialise BullMQ queue and worker.
 * Only starts if redis_url is configured in platform_settings.
 * Called from server.js on startup — failure is non-fatal (logged as warning).
 */
async function initScheduler() {
  const schedulingEnabled = String((await getSetting('scheduling_enabled')) ?? '1').trim();
  if (schedulingEnabled === '0' || schedulingEnabled.toLowerCase() === 'false') {
    console.warn('[scheduler] scheduling_enabled=0 — scheduler disabled by kill-switch');
    schedulingEnabledCache = false;
    return;
  }
  schedulingEnabledCache = true;

  const redisUrl = (process.env.REDIS_URL || '').trim() || (await getSetting('redis_url'));
  if (!redisUrl) {
    console.warn('[scheduler] redis_url not set in platform_settings — scheduling disabled');
    return;
  }

  const { Queue, Worker } = require('bullmq');
  const IORedis = require('ioredis');
  const { publishScheduledPost } = require('./linkedinPublisher');

  // BullMQ requires separate IORedis instances for Queue and Worker.
  // The Worker uses blocking commands (BRPOP/BLMOVE) that hold the connection,
  // which would prevent the Queue from sending non-blocking commands on the same connection.
  const queueConnection  = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const workerConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  postQueue = new Queue('linkedin-posts', { connection: queueConnection });
  schedulerEnabled = true;

  workerInstance = new Worker('linkedin-posts', async job => {
    const { scheduledPostId } = job.data;
    // Pass BullMQ attempt metadata so publishScheduledPost can distinguish
    // a transient retry from a final failure.
    await publishScheduledPost(scheduledPostId, {
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts?.attempts ?? 3,
    });
  }, {
    connection: workerConnection,
    concurrency: 1,
  });

  workerInstance.on('failed', (job, err) => {
    console.error(`[scheduler] Job ${job?.id} failed after ${job?.attemptsMade} attempts:`, err.message);
  });

  workerInstance.on('completed', job => {
    console.log(`[scheduler] Job ${job.id} completed (scheduledPostId=${job.data.scheduledPostId})`);
  });

  console.log('[scheduler] BullMQ queue and worker started on', redisUrl);

  // Re-enqueue any pending scheduled posts whose BullMQ jobs were lost (e.g. server restart)
  const pending = await db.prepare(
    "SELECT id, scheduled_for FROM scheduled_posts WHERE status = 'pending'"
  ).all();

  for (const row of pending) {
    const scheduledFor = new Date(row.scheduled_for);
    const delay = Math.max(0, scheduledFor.getTime() - Date.now()); // 0 = fire immediately if past-due
    const job = await postQueue.add('publish', { scheduledPostId: row.id }, {
      jobId: scheduledJobId(row.id),
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 }, // 1 min → 2 min → 4 min
      removeOnComplete: true,
      removeOnFail: false, // keep failed jobs visible for debugging
    });
    await db.prepare(`
      UPDATE scheduled_posts
      SET bull_job_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(String(job.id), row.id);
    try {
      const meta = await db.prepare('SELECT user_id, tenant_id FROM scheduled_posts WHERE id = ?').get(row.id);
      if (meta) {
        await db.prepare(`
          INSERT INTO scheduled_post_events (scheduled_post_id, user_id, tenant_id, event_type, message)
          VALUES (?, ?, ?, 're_enqueued', ?)
        `).run(row.id, meta.user_id, meta.tenant_id, `bull_job_id=${job.id}`);
      }
    } catch { /* non-fatal */ }
    console.log(`[scheduler] Re-enqueued scheduledPostId=${row.id} delay=${delay}ms`);
  }

  await recoverStuckPosts();

  // Run stuck-post recovery every 10 minutes so posts never stay stuck between restarts.
  setInterval(() => {
    recoverStuckPosts().catch(err =>
      console.error('[scheduler] recoverStuckPosts periodic error:', err.message)
    );
  }, 10 * 60 * 1000);
}

/**
 * Add a delayed job to publish a scheduled post.
 * @param {number} scheduledPostId — row id in scheduled_posts table
 * @param {Date} scheduledFor — when to fire the job
 * @returns {Promise<string>} BullMQ job id
 */
async function addScheduledJob(scheduledPostId, scheduledFor) {
  if (!postQueue) throw new Error('scheduler_not_initialized — redis_url may not be configured');

  const delay = Math.max(0, scheduledFor.getTime() - Date.now());

  const job = await postQueue.add(
    'publish',
    { scheduledPostId },
    {
      jobId: scheduledJobId(scheduledPostId),
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 }, // 1 min → 2 min → 4 min
      removeOnComplete: true,
      removeOnFail: false, // keep failed jobs visible for debugging
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
    // Prefer removing by known job id if present in DB (covers delayed/wait/active states).
    const row = await db.prepare('SELECT bull_job_id FROM scheduled_posts WHERE id = ?').get(scheduledPostId);
    const jobId = row?.bull_job_id || null;

    if (jobId) {
      const job = await postQueue.getJob(jobId);
      if (job) {
        await job.remove();
        return;
      }
    }

    // Fallback for rows created before bull_job_id existed.
    const delayed = await postQueue.getDelayed();
    const match = delayed.find(j => j.data.scheduledPostId === scheduledPostId);
    if (match) await match.remove();
  } catch (err) {
    // Non-fatal — job may have already fired
    console.warn('[scheduler] Could not remove job for scheduledPostId', scheduledPostId, '—', err.message);
  }
}

function isSchedulerEnabled() {
  return schedulingEnabledCache && schedulerEnabled && !!postQueue;
}

function getWorker() {
  return workerInstance;
}

module.exports = { initScheduler, addScheduledJob, removeScheduledJob, isSchedulerEnabled, getWorker, recoverStuckPosts };

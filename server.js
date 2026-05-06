'use strict';

require('dotenv').config();

const express = require('express');
require('express-async-errors');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { db } = require('./db');
const { sendEmail } = require('./emails');

// Initialise DB adapter (schema is managed by migrations)
require('./db');
const { runSeed } = require('./config/seedData');

const app = express();

// ---------------------------------------------------------------------------
// Security middleware
// ---------------------------------------------------------------------------

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", "https://cdn.paddle.com", "https://public.profitwell.com"],
      styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.paddle.com"],
      imgSrc:         ["'self'", "data:", "*.licdn.com", "media.licdn.com", "*.googleusercontent.com"],
      connectSrc:     ["'self'", "https://sandbox-api.paddle.com", "https://api.paddle.com", "https://cdn.paddle.com", "https://buy.paddle.com", "https://sandbox-buy.paddle.com"],
      fontSrc:        ["'self'", "https://fonts.gstatic.com"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],
      frameSrc:       ["https://sandbox-buy.paddle.com", "https://buy.paddle.com"],
    },
  },
}));

const allowedOrigin = process.env.ALLOWED_ORIGIN || null;
if (allowedOrigin) {
  app.use(cors({ origin: allowedOrigin, credentials: true }));
}

// Paddle webhook route removed — subscription state is managed entirely via
// direct Paddle API calls in /api/billing/sync (post-checkout) and
// /api/billing/subscription (stale-refresh on every subscription GET).

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.json({ limit: '30mb' }));

// ---------------------------------------------------------------------------
// Auth (Google OAuth) + session
// ---------------------------------------------------------------------------

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET environment variable is required. Set a strong random string (e.g. openssl rand -hex 32).');
}
const SESSION_SECRET = process.env.SESSION_SECRET;

app.set('trust proxy', 1); // needed on Render/behind proxies for secure cookies

const PgSession = connectPgSimple(session);
app.use(session({
  name: 'scouthook.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new PgSession({
    conString: process.env.DATABASE_URL,
    tableName: 'session',
    pruneSessionInterval: 60 * 15, // prune expired sessions every 15 min
  }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days
  },
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || null;
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || null;

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: GOOGLE_CALLBACK_URL || '/auth/google/callback',
  }, async (accessToken, refreshToken, profile, done) => {
    const email = profile?.emails?.[0]?.value || null;
    const photo = profile?.photos?.[0]?.value || null;
    const googleId = profile?.id || null;
    const userId = googleId ? `google:${googleId}` : (email ? `google_email:${email}` : null);
    if (!userId) return done(null, false);

    // First login == "sign up": ensure an app profile row exists.
    // Awaited so the profile is guaranteed to exist before the session is created.
    try {
      const displayName = profile?.displayName || email || 'User';
      const result = await db.prepare(`
        INSERT INTO user_profiles (user_id, tenant_id, brand_name, email, display_name)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, tenant_id) DO UPDATE SET
          email = EXCLUDED.email,
          display_name = EXCLUDED.display_name
        RETURNING (xmax = 0) AS is_new_row
      `).get(userId, 'default', displayName, email, displayName);

      // Send welcome email only on first login (new row inserted).
      if (result?.is_new_row && email) {
        const appUrl = process.env.APP_URL || '';
        sendEmail('welcome', email, { name: displayName.split(' ')[0] || displayName, app_url: appUrl });
      }
    } catch (err) {
      console.error('[auth] user_profile bootstrap failed for', userId, err.message);
      // Still allow login — profile can be recovered, but log clearly so it's not silent.
    }

    return done(null, {
      provider: 'google',
      id: googleId,
      user_id: userId,
      tenant_id: 'default',
      displayName: profile?.displayName || email || 'User',
      email,
      photo,
    });
  }));
} else {
  console.warn('[auth] Google OAuth is not configured (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
}

app.use(passport.initialize());
app.use(passport.session());

// After passport restores req.user — attach tenant_id and user_id for API routes.
// Both values are derived exclusively from the authenticated session; headers are
// never trusted for identity or tenant resolution.
app.use((req, res, next) => {
  req.tenantId = req.user?.tenant_id || 'default';
  req.userId   = req.user?.user_id   || null;
  next();
});

// API-only rate limit (do not apply globally — static JS/CSS/HTML each count as a request
// and 100/15min per IP breaks normal use). Tighter limits exist on /api/generate.
const apiRateLimitMax = Number(process.env.API_RATE_LIMIT_MAX || 2000);
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number.isFinite(apiRateLimitMax) && apiRateLimitMax > 0 ? apiRateLimitMax : 2000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const uid = req.userId;
    if (uid && String(uid).trim()) return `api:${String(uid).trim()}`;
    return `ip:${ipKeyGenerator(req)}`;
  },
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'rate_limited' });
  },
}));

app.get('/auth/google', (req, res, next) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.redirect('/login.html?error=google_not_configured');
  }
  return passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback',
  (req, res, next) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.redirect('/login.html?error=google_not_configured');
    }
    return passport.authenticate('google', { failureRedirect: '/login.html?error=oauth_failed' })(req, res, next);
  },
  async (req, res) => {
    // Route new users to the onboarding wizard; returning users go straight to dashboard.
    try {
      const row = await db.prepare(
        'SELECT onboarding_complete FROM user_profiles WHERE user_id = ? AND tenant_id = ?'
      ).get(req.user.user_id, 'default');
      if (!row?.onboarding_complete) return res.redirect('/onboarding.html');
    } catch {
      // Non-fatal — fall through to dashboard if the check fails.
    }
    return res.redirect('/dashboard.html');
  }
);

app.post('/auth/logout', (req, res) => {
  const finish = () => {
    res.clearCookie('scouthook.sid');
    res.json({ ok: true });
  };
  if (req.logout) {
    req.logout((err) => {
      if (err) console.error('[logout]', err);
      finish();
    });
  } else if (req.session) {
    req.session.destroy(finish);
  } else {
    finish();
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.isAuthenticated?.() || !req.user) return res.json({ ok: true, user: null });
  return res.json({ ok: true, user: req.user });
});

function requireLoginHtml(req, res, next) {
  if (req.isAuthenticated?.()) return next();
  const returnTo = encodeURIComponent(req.originalUrl || '/dashboard.html');
  return res.redirect(`/login.html?returnTo=${returnTo}`);
}

// ---------------------------------------------------------------------------
// Health check (Render)
// ---------------------------------------------------------------------------
app.get('/healthz', async (req, res) => {
  try {
    const { db } = require('./db');
    await db.prepare('SELECT 1 AS ok').get();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(503).json({ ok: false, error: 'db_unhealthy' });
  }
});

// ---------------------------------------------------------------------------
// Routes (API before static so /api/* is never shadowed by public files)
// ---------------------------------------------------------------------------

app.use('/api/profile', require('./routes/profile'));
app.use('/api/recipes', require('./routes/recipes'));
app.use('/api/generate', require('./routes/generate'));
app.use('/api/visuals', require('./routes/visuals'));
app.use('/api/linkedin', require('./routes/linkedin'));
app.use('/api/events', require('./routes/events'));
app.use('/api/media', require('./routes/media'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/vault', require('./routes/vault'));
app.use('/api/funnel', require('./routes/funnel'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/checklist', require('./routes/checklist'));
app.use('/api/posts', require('./routes/performance'));
app.use('/api', require('./routes/stats'));

// Unmatched /api/* — avoid falling through to static/HTML 404
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'api_not_found' });
});

app.use('/admin', require('./routes/admin'));

// ---------------------------------------------------------------------------
// App entry points (send login first)
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  if (req.isAuthenticated?.()) return res.redirect('/dashboard.html');
  return res.redirect('/login.html');
});

// Protect main app HTML (session + account UI)
app.get([
  '/onboarding.html',
  '/dashboard.html',
  '/generate.html',
  '/drafts.html',
  '/schedule.html',
  '/Published.html',
  '/Media.html',
  '/profile.html',
  '/brand.html',
  '/vault.html',
  '/ideas.html',
], requireLoginHtml);

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Serve generated visuals and uploads behind session auth.
// In local mode: sendFile from disk.  In S3 mode: stream from S3 using the
// authenticated user's tenant/user prefix (only the owner's session resolves the correct key).
const storage = require('./services/storage');

function serveStoredFile(type) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).send('Unauthorized');

    // Extract bare filename — prevent path traversal
    const safePath = path.normalize(req.path).replace(/^(\.\.(\/|\\|$))+/, '');
    const filename = path.basename(safePath);
    if (!filename || filename !== safePath.replace(/^\//, '')) {
      return res.status(400).end();
    }

    const key = storage.buildKey(req.tenantId, req.userId, type, filename);
    await storage.stream(key, res, next);
  };
}

// Serve generated visuals (PNGs, ZIPs, PDFs) — ephemeral, 24h lifetime
app.use('/files',   serveStoredFile('generated'));
// Serve permanent user uploads (never auto-cleaned)
app.use('/uploads', serveStoredFile('uploads'));

// JSON errors for API routes (Express 4 does not catch async throws without express-async-errors)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const path = req.originalUrl || req.url || '';
  if (path.startsWith('/api') || path.startsWith('/auth')) {
    console.error('[http]', req.method, path, err);
    const status = Number(err.status) || Number(err.statusCode) || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || err.code || 'server_error',
    });
  }
  return next(err);
});

// ---------------------------------------------------------------------------
// Clean generated files older than 24 hours (local backend only, runs every hour)
// In S3 mode this is handled by a bucket Lifecycle rule on the */generated/* prefix.
// ---------------------------------------------------------------------------
const fs = require('fs');
const GENERATED_DIR = path.join(__dirname, 'generated');
if (storage.getBackend() === 'local') {
  function cleanGeneratedFiles() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    try {
      for (const file of fs.readdirSync(GENERATED_DIR)) {
        if (file === '.gitkeep') continue;
        const filePath = path.join(GENERATED_DIR, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (e) { /* non-fatal */ }
  }
  setInterval(cleanGeneratedFiles, 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Metrics retention — clear LinkedIn engagement data older than 90 days.
// Per LinkedIn API ToS data minimisation requirements.
// ---------------------------------------------------------------------------
async function metricsRetentionCleanup() {
  try {
    const result = await db.prepare(`
      UPDATE generated_posts
      SET    likes = NULL, comments = NULL, reactions = NULL, last_synced_at = NULL
      WHERE  last_synced_at < (now() - interval '90 days')
    `).run();
    if (result.changes > 0) {
      console.log(`[retention] Cleared metrics for ${result.changes} posts older than 90 days`);
    }
  } catch (e) {
    console.warn('[retention] Metrics cleanup failed (non-fatal):', e.message);
  }
}
// Run once on startup, then daily
metricsRetentionCleanup();
setInterval(metricsRetentionCleanup, 24 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Email: expiring-soon — warn cancelled Pro users 3 days before access ends.
// ---------------------------------------------------------------------------
async function sendExpiringSoonEmails() {
  try {
    const { sendEmailToUser } = require('./emails');
    const appUrl = process.env.APP_URL || '';
    // Find cancelled subscriptions whose period ends in the next 3 days.
    const rows = await db.prepare(`
      SELECT user_id, current_period_end
      FROM user_subscriptions
      WHERE status = 'canceled'
        AND current_period_end IS NOT NULL
        AND current_period_end > now()
        AND current_period_end <= now() + interval '3 days'
    `).all();
    for (const row of rows) {
      const accessEnds = new Date(row.current_period_end).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const dedupKey = `expiring-soon:${row.current_period_end}`;
      sendEmailToUser(row.user_id, 'default', 'expiring-soon', { access_ends: accessEnds, app_url: appUrl },
        { dedupKey, withinHours: 7 * 24 });
    }
  } catch (e) {
    console.warn('[email-cron] expiring-soon check failed (non-fatal):', e.message);
  }
}
// Stagger slightly from metrics cleanup — run daily at a random offset from startup.
setTimeout(() => {
  sendExpiringSoonEmails();
  setInterval(sendExpiringSoonEmails, 24 * 60 * 60 * 1000);
}, 5 * 60 * 1000); // first run 5 minutes after startup

// ---------------------------------------------------------------------------
// Email: weekly digest — sent on Sunday evenings to active users.
// ---------------------------------------------------------------------------
async function sendWeeklyDigestEmails() {
  // Only send on Sundays (getDay() === 0).
  if (new Date().getDay() !== 0) return;
  try {
    const { sendEmailToUser } = require('./emails');
    const appUrl = process.env.APP_URL || '';
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    // Users who have published at least 1 post ever (engaged users worth emailing).
    const users = await db.prepare(`
      SELECT DISTINCT user_id, tenant_id FROM generated_posts WHERE status = 'published'
    `).all();
    for (const { user_id, tenant_id } of users) {
      const [genCount, pubCount] = await Promise.all([
        db.prepare(`SELECT COUNT(*) AS n FROM generation_runs WHERE user_id = ? AND created_at > ?`).get(user_id, oneWeekAgo),
        db.prepare(`SELECT COUNT(*) AS n FROM generated_posts WHERE user_id = ? AND status = 'published' AND published_at > ?`).get(user_id, oneWeekAgo),
      ]);
      const [schedCountRow, nextSchedRow] = await Promise.all([
        db.prepare(`SELECT COUNT(*) AS n FROM scheduled_posts WHERE user_id = ? AND status = 'pending' AND scheduled_for > now()`).get(user_id),
        db.prepare(`SELECT scheduled_for FROM scheduled_posts WHERE user_id = ? AND status = 'pending' AND scheduled_for > now() ORDER BY scheduled_for ASC LIMIT 1`).get(user_id),
      ]);
      const nextPostRow = nextSchedRow
        ? `<p style="margin:0 0 20px;font-size:14px;color:#374151;">Your next post goes live on <strong>${new Date(nextSchedRow.scheduled_for).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</strong>.</p>`
        : '';
      const dedupKey = `weekly:${new Date().toISOString().slice(0, 10)}`;
      sendEmailToUser(user_id, tenant_id, 'weekly-digest', {
        posts_generated: String(genCount?.n || 0),
        posts_published: String(pubCount?.n || 0),
        posts_scheduled: String(schedCountRow?.n || 0),
        next_post_row: nextPostRow,
        app_url: appUrl,
      }, { dedupKey, withinHours: 6 * 24 });
    }
  } catch (e) {
    console.warn('[email-cron] weekly digest failed (non-fatal):', e.message);
  }
}
// Check once every 6 hours — the Sunday guard inside ensures it only sends on Sunday.
setInterval(sendWeeklyDigestEmails, 6 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Scheduler (BullMQ worker — only starts if Redis is configured)
// ---------------------------------------------------------------------------

const { initScheduler } = require('./services/scheduler');
initScheduler().catch(err => {
  console.warn('[scheduler] Redis not configured or unavailable — scheduling disabled:', err.message);
});

const { initRedis } = require('./services/redis');
initRedis().catch(err => {
  console.warn('[redis] shared client init failed:', err.message);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 4000;
(async () => {
  try {
    await runSeed();
  } catch (e) {
    console.warn('[seed] skipped/failed:', e.message);
  }

  const httpServer = app.listen(PORT, () => {
    console.log(`[scouthook] Server running on http://localhost:${PORT}`);
    console.log(`[scouthook] Admin UI: http://localhost:${PORT}/admin.html`);
  });

  // Graceful shutdown — drain in-flight requests and close the BullMQ worker
  // before the process exits. Render (and most PaaS hosts) send SIGTERM on deploy.
  async function shutdown(signal) {
    console.log(`[scouthook] ${signal} received — shutting down gracefully`);
    httpServer.close(() => console.log('[scouthook] HTTP server closed'));
    try {
      const { getWorker } = require('./services/scheduler');
      const worker = getWorker();
      if (worker) await worker.close();
    } catch { /* scheduler may not be running */ }
    try {
      const { getRedis } = require('./services/redis');
      const redis = getRedis();
      if (redis) await redis.quit();
    } catch { /* non-fatal */ }
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
})();

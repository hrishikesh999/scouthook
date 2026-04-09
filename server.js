'use strict';

require('dotenv').config();

const express = require('express');
require('express-async-errors');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { db } = require('./db');

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
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],   // inline scripts in HTML pages
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", "data:", "*.licdn.com", "media.licdn.com"],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));

const allowedOrigin = process.env.ALLOWED_ORIGIN || null;
if (allowedOrigin) {
  app.use(cors({ origin: allowedOrigin, credentials: true }));
}

// General rate limit — 100 requests per 15 min per IP
// (generation endpoints have their own tighter limits)
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.json({ limit: '30mb' }));

// ---------------------------------------------------------------------------
// Auth (Google OAuth) + session
// ---------------------------------------------------------------------------

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev_session_secret_change_me';
if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET is not set; using a dev default (NOT safe for production).');
}

app.set('trust proxy', 1); // needed on Render/behind proxies for secure cookies
app.use(session({
  name: 'scouthook.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
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
  }, (accessToken, refreshToken, profile, done) => {
    const email = profile?.emails?.[0]?.value || null;
    const photo = profile?.photos?.[0]?.value || null;
    const googleId = profile?.id || null;
    const userId = googleId ? `google:${googleId}` : (email ? `google_email:${email}` : null);
    if (!userId) return done(null, false);

    // First login == "sign up": ensure an app profile row exists.
    // We use the existing user_profiles table so the rest of the app has a stable user_id.
    (async () => {
      try {
        await db.prepare(
          "INSERT INTO user_profiles (user_id, tenant_id, brand_name) VALUES (?, ?, ?) ON CONFLICT(user_id, tenant_id) DO NOTHING"
        ).run(userId, 'default', profile?.displayName || email || 'User');
      } catch {
        // Non-fatal; user can still authenticate via session even if profile bootstrap fails.
      }
    })();

    return done(null, {
      provider: 'google',
      id: googleId,
      user_id: userId,
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

// After passport restores req.user — attach tenant_id and user_id for API routes
app.use((req, res, next) => {
  const headerTenant = req.headers['x-tenant-id'] || 'default';
  const headerUser = req.headers['x-user-id'] || null;
  const sessionUserId = req.user?.user_id || null;
  req.tenantId = headerTenant;
  req.userId = sessionUserId || headerUser;
  next();
});

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
  (req, res) => {
    return res.redirect('/dashboard.html');
  }
);

app.post('/auth/logout', (req, res) => {
  req.logout?.(() => {});
  req.session?.destroy(() => {});
  res.clearCookie('scouthook.sid');
  return res.json({ ok: true });
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
  '/dashboard.html',
  '/generate.html',
  '/drafts.html',
  '/schedule.html',
  '/Published.html',
  '/Media.html',
  '/profile.html',
  '/brand.html',
], requireLoginHtml);

app.use(express.static(path.join(__dirname, 'public')));
// Serve generated visuals (PNGs, ZIPs) — files older than 24h are cleaned periodically
app.use('/files', express.static(path.join(__dirname, 'generated')));
// Serve permanent user uploads (never auto-cleaned)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// JSON errors for API routes (Express 4 does not catch async throws without express-async-errors)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const path = req.originalUrl || req.url || '';
  if (path.startsWith('/api') || path.startsWith('/auth')) {
    console.error('[http]', req.method, path, err);
    const status = Number(err.status) || Number(err.statusCode) || 500;
    return res.status(status).json({
      ok: false,
      error: err.code || err.message || 'server_error',
    });
  }
  return next(err);
});

// ---------------------------------------------------------------------------
// Clean generated files older than 24 hours (runs every hour)
// ---------------------------------------------------------------------------
const fs = require('fs');
const GENERATED_DIR = path.join(__dirname, 'generated');
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

// ---------------------------------------------------------------------------
// Scheduler (BullMQ worker — only starts if Redis is configured)
// ---------------------------------------------------------------------------

const { initScheduler } = require('./services/scheduler');
initScheduler().catch(err => {
  console.warn('[scheduler] Redis not configured or unavailable — scheduling disabled:', err.message);
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

  app.listen(PORT, () => {
  console.log(`[scouthook] Server running on http://localhost:${PORT}`);
  console.log(`[scouthook] Admin UI: http://localhost:${PORT}/admin.html`);
  });
})();

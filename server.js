'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

// Initialise DB (creates tables + runs seed on first start)
require('./db');
const { runSeed } = require('./config/seedData');
runSeed();

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
// Review-mode config + session
// ---------------------------------------------------------------------------
const REVIEW_MODE = process.env.REVIEW_MODE === '1';
const SESSION_COOKIE = 'sh_session';
const SESSION_SECRET = process.env.SESSION_SECRET || null;

function base64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecodeToString(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64').toString('utf8');
}

function signSession(payloadObj) {
  if (!SESSION_SECRET) throw new Error('SESSION_SECRET not set');
  const json = JSON.stringify(payloadObj);
  const body = base64urlEncode(json);
  const sig = base64urlEncode(
    crypto.createHmac('sha256', SESSION_SECRET).update(body).digest()
  );
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!SESSION_SECRET) return null;
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = base64urlEncode(
    crypto.createHmac('sha256', SESSION_SECRET).update(body).digest()
  );
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  try {
    const json = base64urlDecodeToString(body);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  const pairs = cookie.split(';').map(s => s.trim());
  for (const p of pairs) {
    const idx = p.indexOf('=');
    if (idx === -1) continue;
    const k = p.slice(0, idx);
    if (k === name) return decodeURIComponent(p.slice(idx + 1));
  }
  return null;
}

// Attach tenant_id and user_id to every request.
// - Full product mode: from X-User-Id/X-Tenant-Id headers (existing behavior)
// - Review mode: from signed cookie session derived from LinkedIn OIDC ("sub")
app.use((req, res, next) => {
  req.tenantId = req.headers['x-tenant-id'] || 'default';
  req.userId = req.headers['x-user-id'] || null;

  if (REVIEW_MODE) {
    const token = getCookie(req, SESSION_COOKIE);
    const sess = verifySession(token);
    if (sess?.sub) {
      req.userId = `li_${sess.sub}`;
      req.tenantId = sess.tid || 'default';
      req.linkedinProfile = {
        sub: sess.sub,
        name: sess.name || null,
        picture: sess.picture || null,
      };
    } else {
      req.userId = null;
    }
  }

  next();
});

// ---------------------------------------------------------------------------
// Review-mode auth gate
// - Redirect unauthenticated users to /login.html for internal HTML pages
// - Return 401 for protected API endpoints
// ---------------------------------------------------------------------------
function isProbablyHtmlRequest(req) {
  const accept = (req.headers.accept || '').toLowerCase();
  if (accept.includes('text/html')) return true;
  return req.path === '/' || req.path.endsWith('.html');
}

function isPublicReviewPath(req) {
  const p = req.path;
  // Public pages
  if (p === '/' || p === '/index.html' || p === '/login.html' || p === '/privacy.html' || p === '/terms.html') return true;

  // Static assets (served from /public, /files, /uploads)
  if (
    p.startsWith('/css/') ||
    p.startsWith('/js/') ||
    p.startsWith('/images/') ||
    p.startsWith('/uploads/') ||
    p.startsWith('/files/') ||
    p === '/favicon.ico'
  ) return true;

  // Public review-mode API endpoints needed for sign-in + UI boot
  if (p === '/api/config') return true;
  if (p === '/api/linkedin/connect') return true;
  if (p === '/api/linkedin/callback') return true;
  if (p === '/api/linkedin/status') return true;

  return false;
}

app.use((req, res, next) => {
  if (!REVIEW_MODE) return next();
  if (req.userId) return next();
  if (isPublicReviewPath(req)) return next();

  // If someone hits the app without a LinkedIn session, force login.
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, error: 'not_authenticated' });
  }
  if (isProbablyHtmlRequest(req)) {
    return res.redirect('/login.html');
  }
  return res.status(401).send('Not authenticated');
});

// Expose config to the frontend (used to toggle review-mode UI)
app.get('/api/config', (req, res) => {
  return res.json({ ok: true, review_mode: REVIEW_MODE });
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
app.use('/admin', require('./routes/admin'));

// Review-mode: hide automation/analytics pages from public UI
if (REVIEW_MODE) {
  app.get(['/schedule.html', '/Published.html'], (req, res) => res.redirect('/dashboard.html'));
}

app.use(express.static(path.join(__dirname, 'public')));
// Serve generated visuals (PNGs, ZIPs) — files older than 24h are cleaned periodically
app.use('/files', express.static(path.join(__dirname, 'generated')));
// Serve permanent user uploads (never auto-cleaned)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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
if (!REVIEW_MODE) {
  initScheduler().catch(err => {
    console.warn('[scheduler] Redis not configured or unavailable — scheduling disabled:', err.message);
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`[scouthook] Server running on http://localhost:${PORT}`);
  console.log(`[scouthook] Admin UI: http://localhost:${PORT}/admin.html`);
});

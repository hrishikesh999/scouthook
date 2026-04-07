'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

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

// Attach tenant_id and user_id to every request from headers
app.use((req, res, next) => {
  req.tenantId = req.headers['x-tenant-id'] || 'default';
  req.userId = req.headers['x-user-id'] || null;
  next();
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
initScheduler().catch(err => {
  console.warn('[scheduler] Redis not configured or unavailable — scheduling disabled:', err.message);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`[scouthook] Server running on http://localhost:${PORT}`);
  console.log(`[scouthook] Admin UI: http://localhost:${PORT}/admin.html`);
});

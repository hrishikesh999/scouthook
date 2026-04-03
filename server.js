'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');

// Initialise DB (creates tables + runs seed on first start)
require('./db');
const { runSeed } = require('./config/seedData');
runSeed();

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Serve generated visuals (PNGs, ZIPs) — files older than 24h are cleaned periodically
app.use('/files', express.static(path.join(__dirname, 'generated')));

// Attach tenant_id and user_id to every request from headers
app.use((req, res, next) => {
  req.tenantId = req.headers['x-tenant-id'] || 'default';
  req.userId = req.headers['x-user-id'] || null;
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use('/api/profile', require('./routes/profile'));
app.use('/api/recipes', require('./routes/recipes'));
app.use('/api/generate', require('./routes/generate'));
app.use('/api/visuals', require('./routes/visuals'));
app.use('/api/linkedin', require('./routes/linkedin'));
app.use('/api/events', require('./routes/events'));
app.use('/admin', require('./routes/admin'));

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[scouthook] Server running on http://localhost:${PORT}`);
  console.log(`[scouthook] Admin UI: http://localhost:${PORT}/admin.html`);
});

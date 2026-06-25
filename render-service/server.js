'use strict';

const fastify = require('fastify')({ logger: true });
const puppeteer = require('puppeteer-core');

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';
const PORT = parseInt(process.env.PORT || '8080', 10);
const RENDER_SECRET = process.env.FLY_RENDER_SECRET || '';
const MAX_CONCURRENT = 3;

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--disable-extensions',
];

// ── Browser singleton ───────────────────────────────────────────────────────

let browser = null;

async function launchBrowser() {
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    args: LAUNCH_ARGS,
    headless: 'new',
  });
  browser.on('disconnected', () => {
    fastify.log.warn('[render] browser disconnected');
    browser = null;
  });
  fastify.log.info('[render] browser launched');
}

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    await launchBrowser();
  }
  return browser;
}

// ── Concurrency semaphore ───────────────────────────────────────────────────

let activeCount = 0;
const waitQueue = [];

function acquireSlot() {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++;
    return Promise.resolve();
  }
  return new Promise(resolve => waitQueue.push(resolve));
}

function releaseSlot() {
  const next = waitQueue.shift();
  if (next) {
    next();
  } else {
    activeCount--;
  }
}

// ── Core render function ────────────────────────────────────────────────────

async function renderHtml(html, width, height) {
  await acquireSlot();
  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 10_000 });
    const png = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width, height },
    });
    return png;
  } catch (err) {
    // On page-level error, attempt one browser restart
    fastify.log.error('[render] page error, attempting browser restart:', err.message);
    try { if (page) await page.close(); } catch (_) {}
    page = null;
    try {
      if (browser) await browser.close();
    } catch (_) {}
    browser = null;
    await launchBrowser();
    // retry once with fresh browser
    const b2 = await getBrowser();
    page = await b2.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 10_000 });
    const png = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width, height },
    });
    return png;
  } finally {
    try { if (page) await page.close(); } catch (_) {}
    releaseSlot();
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try { done(null, JSON.parse(body)); } catch (e) { done(e); }
});

fastify.get('/health', async () => ({
  ok: true,
  queued: waitQueue.length,
  active: activeCount,
}));

fastify.post('/render', async (req, reply) => {
  const secret = req.headers['x-render-secret'];
  if (!RENDER_SECRET || secret !== RENDER_SECRET) {
    return reply.status(401).send({ ok: false, error: 'unauthorized' });
  }

  const { html, width = 1080, height = 1080 } = req.body || {};
  if (!html || typeof html !== 'string') {
    return reply.status(400).send({ ok: false, error: 'html is required' });
  }

  try {
    const png = await renderHtml(html, Number(width), Number(height));
    return reply.type('image/png').send(png);
  } catch (err) {
    fastify.log.error('[render] render failed:', err.message);
    return reply.status(503).send({ ok: false, error: 'render_failed', detail: err.message });
  }
});

// ── Startup ─────────────────────────────────────────────────────────────────

async function start() {
  await launchBrowser();
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`[render] listening on port ${PORT}`);
}

start().catch(err => {
  console.error('[render] startup error:', err);
  process.exit(1);
});

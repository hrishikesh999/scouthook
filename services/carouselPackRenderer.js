'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const { getSetting } = require('../db');
const storage = require('./storage');
const { injectSlots } = require('./templateSlotInjector');
const { callRenderService } = require('./templateRenderer');
const { buildCarouselPdfFromBuffers } = require('./carouselGenerator');
const { extractJsonFromResponse, getAnthropicMessageText } = require('./voiceFingerprint');
const { redisSet, redisGet } = require('./redis');

// ---------------------------------------------------------------------------
// Job queue — same Redis/in-memory pattern as templateRenderer.js
// ---------------------------------------------------------------------------

const renderJobs = new Map();
const JOB_TTL_SECONDS = 600;

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_SECONDS * 1000;
  for (const [id, job] of renderJobs) {
    if (job.createdAt < cutoff) renderJobs.delete(id);
  }
}, 60_000);

async function _setJob(jobId, data) {
  const stored = await redisSet(`carousel_job:${jobId}`, data, JOB_TTL_SECONDS);
  if (!stored) renderJobs.set(jobId, { ...data, createdAt: Date.now() });
}

async function getCarouselJobStatus(jobId) {
  const fromRedis = await redisGet(`carousel_job:${jobId}`);
  if (fromRedis) return fromRedis;
  return renderJobs.get(jobId) || null;
}

// ---------------------------------------------------------------------------
// Load pack with slides and template data
// ---------------------------------------------------------------------------

async function loadPack(packId) {
  const pack = await db.prepare('SELECT * FROM carousel_packs WHERE id = ?').get(packId);
  if (!pack) return null;

  const slides = await db.prepare(
    `SELECT s.*, t.name AS template_name, t.html_r2_key, t.slot_manifest
     FROM carousel_pack_slides s
     JOIN html_templates t ON t.id = s.template_id
     WHERE s.pack_id = ?
     ORDER BY s.slide_order`
  ).all(packId);

  return { pack, slides };
}

// ---------------------------------------------------------------------------
// Extract carousel content via AI
// ---------------------------------------------------------------------------

async function extractCarouselPackContent(post, pack, slides) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const variableMap = pack.variable_map || {};
  const canonicalSlots = variableMap.slots || {};

  // Build slot descriptions using canonical names
  const titleSlots = [], contentSlots = [], closingSlots = [];

  for (const [canonical, roleMap] of Object.entries(canonicalSlots)) {
    if (roleMap.title) titleSlots.push(canonical);
    if (roleMap.content) contentSlots.push(canonical);
    if (roleMap.closing) closingSlots.push(canonical);
  }

  // Also add slots from templates not in the variable map (image slots, etc.)
  for (const slide of slides) {
    const manifest = typeof slide.slot_manifest === 'string'
      ? JSON.parse(slide.slot_manifest) : slide.slot_manifest;
    const slotDefs = manifest?.slots || {};
    for (const key of Object.keys(slotDefs)) {
      if (key.startsWith('color:') || key.startsWith('image:')) continue;
      const target = slide.role === 'title' ? titleSlots
        : slide.role === 'closing' ? closingSlots : contentSlots;
      if (!target.includes(key)) target.push(key);
    }
  }

  const { min_content_slides: minSlides = 3, max_content_slides: maxSlides = 8 } = pack;

  const prompt = `Break this LinkedIn post into a multi-slide carousel.

TITLE SLIDE — return these fields:
${titleSlots.map(s => `- "${s}": string (concise, attention-grabbing)`).join('\n')}

CONTENT SLIDES — generate ${minSlides} to ${maxSlides} slides, one per key idea:
${contentSlots.map(s => `- "${s}": string`).join('\n')}

CLOSING SLIDE — return these fields:
${closingSlots.map(s => `- "${s}": string (call-to-action, summary, or engagement prompt)`).join('\n')}

Rules:
- Be concise — each slide is a visual card, not an article
- Preserve the author's voice and key stats
- Each content slide should cover one distinct idea
- Return ONLY valid JSON, no markdown fences

Return:
{
  "title": { ${titleSlots.map(s => `"${s}": "..."`).join(', ')} },
  "content_slides": [
    { ${contentSlots.map(s => `"${s}": "..."`).join(', ')} }
  ],
  "closing": { ${closingSlots.map(s => `"${s}": "..."`).join(', ')} }
}

POST:
${post.content}`;

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  let extracted;
  const rawText = getAnthropicMessageText(msg);
  try {
    extracted = extractJsonFromResponse(rawText);
  } catch {
    const retry = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 3000,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: msg.content },
        { role: 'user', content: 'Return only valid JSON, no other text.' },
      ],
    });
    extracted = extractJsonFromResponse(getAnthropicMessageText(retry));
  }

  return extracted;
}

// ---------------------------------------------------------------------------
// Map canonical slot/color names to template-specific names
// ---------------------------------------------------------------------------

function mapContentToSlots(content, variableMap, role) {
  const mapped = {};
  const slotMap = variableMap.slots || {};
  const colorMap = variableMap.colors || {};

  // Map text/repeating slots: canonical → template-specific key
  for (const [canonical, value] of Object.entries(content)) {
    const roleMap = slotMap[canonical];
    const templateKey = roleMap?.[role] || canonical;
    if (templateKey) mapped[templateKey] = value;
  }

  return mapped;
}

function resolveColorSlots(manifest, variableMap, role, brand, userOverrides) {
  const colorSlots = {};
  const colorMap = variableMap.colors || {};
  const overrideColors = userOverrides?.colors || {};
  const slots = manifest.slots || {};

  for (const [key, def] of Object.entries(slots)) {
    if (!key.startsWith('color:')) continue;

    // Check for user override (by canonical name or template-specific name)
    const varName = key.slice('color:'.length);
    let canonicalName = varName;
    for (const [canonical, roleMapping] of Object.entries(colorMap)) {
      if (roleMapping[role] === '--' + varName) { canonicalName = canonical; break; }
    }

    if (overrideColors[canonicalName] || overrideColors[key]) {
      colorSlots[key] = overrideColors[canonicalName] || overrideColors[key];
    } else if (def.default === 'brand') {
      const colorRole = varName;
      colorSlots[key] = brand[colorRole] || brand.accent || '#0f766e';
    } else if (def.default) {
      colorSlots[key] = def.default;
    }
  }

  return colorSlots;
}

// ---------------------------------------------------------------------------
// Render a carousel pack
// ---------------------------------------------------------------------------

async function renderCarouselPack(post, packId, userOverrides, brand, ctx) {
  const { userId, tenantId } = ctx;
  const loaded = await loadPack(packId);
  if (!loaded) throw Object.assign(new Error('pack_not_found'), { status: 404 });

  const { pack, slides } = loaded;
  const variableMap = typeof pack.variable_map === 'string'
    ? JSON.parse(pack.variable_map) : (pack.variable_map || {});

  // Extract content via AI
  const extracted = await extractCarouselPackContent(post, pack, slides);

  // Build ordered slide list: title, content[0..N], closing
  const titleSlides = slides.filter(s => s.role === 'title');
  const contentTemplates = slides.filter(s => s.role === 'content');
  const closingSlides = slides.filter(s => s.role === 'closing');

  const contentData = extracted.content_slides || [];
  const slideQueue = [];

  // Title
  if (titleSlides.length) {
    slideQueue.push({ slide: titleSlides[0], content: extracted.title || {}, role: 'title' });
  }

  // Content slides — round-robin through content templates
  for (let i = 0; i < contentData.length; i++) {
    const tpl = contentTemplates[i % contentTemplates.length] || contentTemplates[0];
    if (tpl) slideQueue.push({ slide: tpl, content: contentData[i], role: 'content' });
  }

  // Closing
  if (closingSlides.length) {
    slideQueue.push({ slide: closingSlides[0], content: extracted.closing || {}, role: 'closing' });
  }

  // Cache for downloaded HTML (same template reused across content slides)
  const htmlCache = new Map();

  const pngBuffers = [];
  const slideResults = [];
  const total = slideQueue.length;

  for (let i = 0; i < slideQueue.length; i++) {
    const { slide, content, role } = slideQueue[i];
    const manifest = typeof slide.slot_manifest === 'string'
      ? JSON.parse(slide.slot_manifest) : slide.slot_manifest;
    const dims = manifest?.dimensions || { width: 1080, height: 1080 };

    // Download HTML (cached)
    let html;
    if (htmlCache.has(slide.template_id)) {
      html = htmlCache.get(slide.template_id);
    } else {
      const buf = await storage.downloadAdmin(slide.html_r2_key);
      html = buf.toString('utf8');
      htmlCache.set(slide.template_id, html);
    }

    // Map canonical content → template-specific slot names
    const mappedContent = mapContentToSlots(content, variableMap, role);

    // Resolve colors
    const colorSlots = resolveColorSlots(manifest, variableMap, role, brand || {}, userOverrides);

    // Inject all slots
    const allSlots = { ...mappedContent, ...colorSlots };
    const finalHtml = injectSlots(html, allSlots);

    // Render
    const pngBuffer = await callRenderService(finalHtml, dims.width, dims.height);

    // Upload
    const filename = `carousel_${post.id}_${Date.now()}_slide${i + 1}.png`;
    await storage.upload(pngBuffer, { tenantId, userId, type: 'generated', filename, mimeType: 'image/png' });
    pngBuffers.push(pngBuffer);
    slideResults.push({ png_url: `/files/${filename}`, slide_index: i + 1, role });

    // Update job progress
    if (ctx._jobId) {
      await _setJob(ctx._jobId, {
        status: 'rendering',
        progress: { current: i + 1, total },
        slides: slideResults,
        pdf_url: null,
        error: null,
      });
    }

    console.log('[carouselPackRenderer] rendered slide %d/%d (role=%s, %dx%d)',
      i + 1, total, role, dims.width, dims.height);
  }

  // Build PDF
  let pdfUrl = null;
  try {
    const pdfBuffer = await buildCarouselPdfFromBuffers(pngBuffers);
    const pdfFilename = `carousel_${post.id}_${Date.now()}.pdf`;
    await storage.upload(pdfBuffer, { tenantId, userId, type: 'generated', filename: pdfFilename, mimeType: 'application/pdf' });
    pdfUrl = `/files/${pdfFilename}`;
    console.log('[carouselPackRenderer] PDF generated (%d bytes)', pdfBuffer.length);
  } catch (err) {
    console.warn('[carouselPackRenderer] PDF generation failed:', err.message);
  }

  return { slides: slideResults, pdf_url: pdfUrl, content: extracted };
}

// ---------------------------------------------------------------------------
// Async job wrapper
// ---------------------------------------------------------------------------

function startCarouselPackJob(jobId, post, packId, userOverrides, brand, ctx) {
  renderJobs.set(jobId, {
    status: 'rendering',
    progress: { current: 0, total: 0 },
    slides: [],
    pdf_url: null,
    error: null,
    createdAt: Date.now(),
  });
  _setJob(jobId, { status: 'rendering', progress: { current: 0, total: 0 }, slides: [], pdf_url: null, error: null });

  renderCarouselPack(post, packId, userOverrides, brand, { ...ctx, _jobId: jobId })
    .then(result => {
      _setJob(jobId, {
        status: 'done',
        progress: { current: result.slides.length, total: result.slides.length },
        slides: result.slides,
        pdf_url: result.pdf_url,
        content: result.content,
        error: null,
      });
    })
    .catch(err => {
      console.error('[carouselPackRenderer] job %s failed:', jobId, err.message);
      _setJob(jobId, { status: 'failed', slides: [], pdf_url: null, error: err.message });
    });
}

module.exports = {
  extractCarouselPackContent,
  renderCarouselPack,
  startCarouselPackJob,
  getCarouselJobStatus,
  loadPack,
};

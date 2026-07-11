'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting, db } = require('../db');
const { extractJsonFromResponse, getAnthropicMessageText } = require('./voiceFingerprint');
const storage = require('./storage');
const { readSlotManifest, injectSlots } = require('./templateSlotInjector');
const sharp = require('sharp');

const FLY_RENDER_URL    = process.env.FLY_RENDER_URL    || '';
const FLY_RENDER_SECRET = process.env.FLY_RENDER_SECRET || '';

// ---------------------------------------------------------------------------
// Render service call
// ---------------------------------------------------------------------------

async function callRenderService(html, width, height) {
  if (!FLY_RENDER_URL) throw Object.assign(new Error('render_service_not_configured'), { status: 503 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  let res;
  try {
    res = await fetch(`${FLY_RENDER_URL}/render`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Render-Secret': FLY_RENDER_SECRET,
      },
      body: JSON.stringify({ html, width, height }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = err.name === 'AbortError'
      ? 'render_service_timeout (15s)'
      : `render_service_unavailable: ${err.message}`;
    throw Object.assign(new Error(reason), { status: 503, cause: err });
  }
  clearTimeout(timer);

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const msg = detail
      ? `render_service_error (${res.status}): ${detail.slice(0, 200)}`
      : `render_service_error (${res.status})`;
    throw Object.assign(new Error(msg), { status: 503 });
  }

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// ---------------------------------------------------------------------------
// Brand color role mapping
// ---------------------------------------------------------------------------

function blendHex(hexA, hexB, ratio) {
  const parse = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
  const a = parse(hexA), b = parse(hexB);
  return '#' + a.map((v, i) => Math.round(v * ratio + b[i] * (1 - ratio)).toString(16).padStart(2, '0')).join('');
}

function resolveBrandRole(role, brand) {
  const r = role.toLowerCase();
  if (brand[r]) return brand[r];
  if (/^(bg|background|card_bg|card-bg|surface|secondary_bg|secondary-bg)$/.test(r)) return brand.bg;
  if (/^(text|heading|heading_color|title|subtitle|body|label|caption)$/.test(r)) return brand.text;
  if (/^(text_muted|text-muted|muted|secondary_text|secondary-text)$/.test(r)) return blendHex(brand.text, brand.bg, 0.45);
  if (/^(accent|brand|highlight|primary|cta|button|badge|tag|link)$/.test(r)) return brand.accent;
  if (/^(border|line|divider|separator|rule)$/.test(r)) return blendHex(brand.text, brand.bg, 0.2);
  if (/^(overlay)$/.test(r)) return 'rgba(0,0,0,0.5)';
  // Unrecognized role: return null so callers keep the template's original
  // color instead of repainting the design with the accent. Must stay in
  // lockstep with _resolveBrandColor in public/editor.html.
  return null;
}

// ---------------------------------------------------------------------------
// Placeholder text for thumbnail generation (deterministic, no AI)
// ---------------------------------------------------------------------------

const TEXT_PLACEHOLDERS = {
  headline: 'Your Headline Goes Here',
  title:    'Title Goes Here',
  subtitle: 'A short supporting subtitle',
  tag:      'CATEGORY',
  label:    'LABEL',
  name:     'Your Name',
  body:     'A short body text placeholder for this slot.',
  cta:      'Get Started',
  date:     'June 2026',
};

function placeholderForKey(key) {
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(TEXT_PLACEHOLDERS)) {
    if (lower.includes(k)) return v;
  }
  return `${key} text here`;
}

// Neutral palette for thumbnail renders — brand-mapped color slots resolve
// against this per role, so backgrounds/text/accents stay distinguishable.
const THUMBNAIL_PREVIEW_BRAND = { bg: '#ffffff', text: '#111827', accent: '#0f766e' };

// ---------------------------------------------------------------------------
// generateTemplateThumbnail
// No post, no AI, no brand context — deterministic placeholder content.
// Returns a PNG Buffer resized to 540px wide.
// ---------------------------------------------------------------------------

async function generateTemplateThumbnail(html, manifest) {
  const { width = 1080, height = 1080 } = manifest.dimensions || {};
  const slots = manifest.slots || {};

  const placeholderSlots = {};

  for (const [key, def] of Object.entries(slots)) {
    if (key.startsWith('color:')) {
      // Brand-mapped slots ({default:'brand', brandRole:'bg'|'text'|...}) must
      // resolve per role — a flat teal for every role renders bg and text the
      // same color, producing a solid teal card with invisible text.
      let val;
      if (def.brandRole) val = resolveBrandRole(def.brandRole, THUMBNAIL_PREVIEW_BRAND);
      else if (def.default === 'brand') val = THUMBNAIL_PREVIEW_BRAND.accent;
      else val = def.default || '#cccccc';
      if (val) placeholderSlots[key] = val; // null = unrecognized role — keep the template's own color
      continue;
    }
    if (key.startsWith('image:')) {
      // Skip — no placeholder images for thumbnails
      continue;
    }
    if (def.type === 'repeating') {
      const count = def.min || 2;
      const fields = def.fields || ['title', 'body'];
      placeholderSlots[key] = Array.from({ length: count }, () => {
        const item = {};
        for (const f of fields) item[f] = `${f} placeholder`;
        return item;
      });
      continue;
    }
    // text slot
    let val = placeholderForKey(key);
    if (def.maxLen) val = val.slice(0, Math.floor(def.maxLen / 2));
    placeholderSlots[key] = val;
  }

  const finalHtml = injectSlots(html, placeholderSlots);
  const fullPng = await callRenderService(finalHtml, width, height);
  return sharp(fullPng).resize(540).png().toBuffer();
}

// ---------------------------------------------------------------------------
// Claude Haiku extraction
// Builds a dynamic prompt from the manifest's text/repeating slot definitions
// ---------------------------------------------------------------------------

async function extractSlotContent(post, manifest) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const slots = manifest.slots || {};
  const slotDescriptions = [];

  for (const [key, def] of Object.entries(slots)) {
    if (key.startsWith('color:') || key.startsWith('image:')) continue;
    if (def.type === 'repeating') {
      const fields = (def.fields || ['title', 'body']).join(', ');
      slotDescriptions.push(
        `- "${key}": array of ${def.min || 2}–${def.max || 6} objects each with { ${fields} }`
      );
    } else {
      let lengthHint = '';
      if (def.maxLen) {
        const approxWords = Math.max(2, Math.round(def.maxLen / 5));
        if (def.maxLen <= 40)       lengthHint = ` — ${approxWords}-${approxWords + 1} words max, ultra-short`;
        else if (def.maxLen <= 80)  lengthHint = ` — ${approxWords}-${approxWords + 2} words max, short phrase`;
        else if (def.maxLen <= 160) lengthHint = ` — ${approxWords}-${approxWords + 4} words max, one sentence`;
        else                        lengthHint = ` — ${approxWords}+ words, 1-2 sentences`;
      }
      const maxNote = def.maxLen ? ` (max ${def.maxLen} chars${lengthHint})` : '';
      const reqNote = def.required ? ' [REQUIRED]' : '';
      slotDescriptions.push(`- "${key}": string${maxNote}${reqNote}`);
    }
  }

  if (slotDescriptions.length === 0) return {};

  const prompt = `You are filling text fields for a visual LinkedIn card. Each field is a standalone text block shown on a designed image. Your job is to EXTRACT and CONDENSE content directly from the post — do NOT invent, embellish, or add anything not present in the post.

Return ONLY valid JSON with these exact keys:

${slotDescriptions.join('\n')}

Rules:
- ONLY use information explicitly stated in the post. If a field's content cannot be found in the post, use an empty string "" — never guess or fabricate.
- CRITICAL: Generate text that fits comfortably UNDER each field's character limit — never at or over.
- Small maxLen (≤40 chars) = a short title or label (3-6 words). Do NOT write a full sentence.
- Medium maxLen (41-160 chars) = a single punchy sentence.
- Large maxLen (>160 chars) = 1-2 sentences max.
- Preserve the author's exact words, numbers, and stats — do not paraphrase statistics.
- Do NOT wrap in markdown code fences. Return raw JSON only.

POST:
${post.content}`;

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  let extracted;
  const rawText = getAnthropicMessageText(msg);
  try {
    extracted = extractJsonFromResponse(rawText);
  } catch (e) {
    const retry = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: msg.content },
        { role: 'user', content: 'Return only valid JSON, no other text.' },
      ],
    });
    extracted = extractJsonFromResponse(getAnthropicMessageText(retry));
  }

  // Enforce maxLen and strip empty sentinel values (AI returns "" when content not found in post)
  for (const [key, def] of Object.entries(slots)) {
    if (key.startsWith('color:') || key.startsWith('image:')) continue;
    if (typeof extracted[key] === 'string') {
      extracted[key] = extracted[key].trim();
      if (extracted[key] === '') {
        delete extracted[key]; // leave field at its default rather than blanking it
      } else if (def.maxLen) {
        extracted[key] = extracted[key].slice(0, def.maxLen);
      }
    }
  }

  return extracted;
}

// ---------------------------------------------------------------------------
// extractTemplateSlots — extract mode only, no rendering
// ---------------------------------------------------------------------------

async function extractTemplateSlots(post, templateId) {
  const template = await db.prepare(
    'SELECT * FROM html_templates WHERE id = ? AND active = TRUE'
  ).get(templateId);
  if (!template) {
    const err = new Error('template_not_found');
    err.status = 404;
    throw err;
  }

  const manifest = template.slot_manifest; // pg returns JSONB pre-parsed
  return extractSlotContent(post, manifest);
}

// ---------------------------------------------------------------------------
// renderTemplate — full render pipeline
// ---------------------------------------------------------------------------

async function renderTemplate(post, templateId, userOverrides = {}, brand = {}, ctx = {}) {
  const { tenantId, userId } = ctx;

  // 1. Load template
  const template = await db.prepare(
    'SELECT * FROM html_templates WHERE id = ? AND active = TRUE'
  ).get(templateId);
  if (!template) {
    const err = new Error('template_not_found');
    err.status = 404;
    throw err;
  }

  // 2. Download HTML
  const htmlBuf = await storage.downloadAdmin(template.html_r2_key);
  const html = htmlBuf.toString('utf8');

  // 3. Manifest (pre-parsed JSONB from pg)
  const manifest = template.slot_manifest;
  const slots = manifest.slots || {};
  const { width = 1080, height = 1080 } = manifest.dimensions || {};

  // 4. Text + repeating slots come straight from the form — it is the single
  //    source of truth at render time. AI extraction runs ONLY via the explicit
  //    "Fill with AI" buttons (mode:'extract'), never silently here, so a field
  //    the user cleared renders empty instead of being refilled from the post.
  const textSlots = {};
  for (const [key, val] of Object.entries(userOverrides)) {
    if (key === 'colors' || key === 'images') continue;
    if (key.startsWith('color:') || key.startsWith('image:')) continue;
    if (typeof val === 'string') {
      textSlots[key] = val; // honor explicit value including '' (user cleared)
    } else if (Array.isArray(val) && slots[key]?.type === 'repeating') {
      textSlots[key] = val;
    }
  }

  // 5. Resolve color slots — only inject explicit user overrides. Selecting a
  //    template must render ITS OWN design, including for brand-mapped slots
  //    (def.default === 'brand') — brand colors are applied only when the user
  //    explicitly clicked "Apply Brand Colors" in the editor, which resolves
  //    the hex client-side (_resolveBrandColor) and sends it here as a normal
  //    override. No silent server-side brand fallback, mirroring step 4's text
  //    handling — the form is the single source of truth at render time.
  const colorSlots = {};
  const overrideColors = (userOverrides && userOverrides.colors) || {};
  for (const key of Object.keys(slots)) {
    if (!key.startsWith('color:')) continue;
    if (overrideColors[key] && /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))$/.test(overrideColors[key])) {
      colorSlots[key] = overrideColors[key];
    }
    // Skip everything else — the template HTML already has the real values
  }

  // 6. Resolve image slots — driven by what the user actually uploaded
  //    (overrideImages), matched against declared manifest keys. Not gated on
  //    key.startsWith('image:'): a slot manually added in the admin without
  //    following the "image:" prefix convention (bare key, e.g. "photo")
  //    still needs its upload applied — injectSlots/injectImageSlot route it
  //    correctly by value shape and fall back to a bare data-slot lookup.
  const imageSlots = {};
  const overrideImages = (userOverrides && userOverrides.images) || {};
  for (const [key, rawImageKey] of Object.entries(overrideImages)) {
    if (!rawImageKey || !(key in slots)) continue;
    const storageKey = rawImageKey.includes('/') ? rawImageKey : storage.buildMemberKey(tenantId, userId, 'uploads', rawImageKey);
    try {
      const buf = await storage.download(storageKey);
      // Re-encode to bound payload size — raw uploads (e.g. phone photos) can be
      // several MB each, and N of them inlined as base64 into one HTML payload
      // can exceed the render service's request body limit (FST_ERR_CTP_BODY_TOO_LARGE).
      // Slots like image:logo can be transparent PNGs (e.g. a logo over a colored
      // banner) — flattening those to JPEG would bake in a white background, so
      // only JPEG-compress when the source has no alpha channel to preserve.
      const pipeline = sharp(buf).resize(1600, 1600, { fit: 'inside', withoutEnlargement: true });
      const { hasAlpha } = await pipeline.metadata();
      const mime = hasAlpha ? 'image/png' : 'image/jpeg';
      const resized = hasAlpha
        ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
        : await pipeline.jpeg({ quality: 80 }).toBuffer();
      imageSlots[key] = `data:${mime};base64,${resized.toString('base64')}`;
    } catch (err) {
      console.warn(`[templateRenderer] could not load image slot ${key}:`, err.message);
    }
  }

  // 7. Inject all slots
  const allSlots = { ...textSlots, ...colorSlots, ...imageSlots };
  const finalHtml = injectSlots(html, allSlots);

  // 8. Call render service
  const pngBuffer = await callRenderService(finalHtml, width, height);

  // 9. Upload to tenant storage
  const filename = `template_${post.id}_${Date.now()}.png`;
  await storage.upload(pngBuffer, {
    tenantId,
    userId,
    type: 'generated',
    filename,
    mimeType: 'image/png',
  });

  return { png_url: `/files/${filename}`, content: textSlots };
}

// ---------------------------------------------------------------------------
// Async render job queue — Redis-backed with in-memory fallback
// ---------------------------------------------------------------------------

const { redisSet, redisGet } = require('./redis');
const renderJobs = new Map(); // fallback when Redis unavailable

const JOB_TTL_SECONDS = 600; // 10 minutes

// Clean up in-memory fallback Map every 60s
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_SECONDS * 1000;
  for (const [id, job] of renderJobs) {
    if (job.createdAt < cutoff) renderJobs.delete(id);
  }
}, 60_000);

async function _setJob(jobId, data) {
  const stored = await redisSet(`render_job:${jobId}`, data, JOB_TTL_SECONDS);
  if (!stored) renderJobs.set(jobId, { ...data, createdAt: Date.now() });
}

function startRenderJob(jobId, post, templateId, userOverrides, brand, ctx) {
  // Synchronously set in-memory so the first poll never misses
  renderJobs.set(jobId, { status: 'rendering', png_url: null, error: null, createdAt: Date.now() });
  _setJob(jobId, { status: 'rendering', png_url: null, error: null });

  renderTemplate(post, templateId, userOverrides, brand, ctx)
    .then(result => {
      _setJob(jobId, { status: 'done', png_url: result.png_url, content: result.content, error: null });
    })
    .catch(err => {
      console.error('[templateRenderer] render job %s failed:', jobId, err.message);
      _setJob(jobId, { status: 'failed', png_url: null, error: err.message });
    });
}

async function getRenderJobStatus(jobId) {
  const fromRedis = await redisGet(`render_job:${jobId}`);
  if (fromRedis) return fromRedis;
  return renderJobs.get(jobId) || null;
}

module.exports = { renderTemplate, extractTemplateSlots, generateTemplateThumbnail, startRenderJob, getRenderJobStatus, callRenderService };

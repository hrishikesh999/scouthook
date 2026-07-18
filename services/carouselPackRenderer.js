'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { db, getSetting } = require('../db');
const storage = require('./storage');
const { injectSlots } = require('./templateSlotInjector');
const { callRenderService } = require('./templateRenderer');
const { buildCarouselPdfFromBuffers } = require('./carouselGenerator');
const { loadLinkedInAvatarDataUri } = require('./linkedinOAuth');
const { extractJsonFromResponse, getAnthropicMessageText } = require('./voiceFingerprint');
const { buildSharedAuthorContext } = require('./generationCore');
const { resolveProfile } = require('../lib/resolveProfile');
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

  // Layout variants: templates sharing a variant_group with a pack slide but
  // not part of the base slide sequence. Shaped like slide rows so callers
  // can treat them uniformly. Queried separately (not in the main JOIN) so a
  // missing variant_group column (migration 075 not applied) degrades to
  // "no variants" instead of breaking the render path.
  let variants = [];
  try {
    const templateIds = slides.map(s => s.template_id);
    let withGroup = [];
    if (templateIds.length) {
      const idPlaceholders = templateIds.map(() => '?').join(', ');
      const groupRows = await db.prepare(
        `SELECT id AS template_id, variant_group FROM html_templates
         WHERE id IN (${idPlaceholders}) AND variant_group IS NOT NULL`
      ).all(...templateIds);
      const roleById = new Map(slides.map(s => [s.template_id, s.role]));
      withGroup = groupRows.map(r => ({ variant_group: r.variant_group, role: roleById.get(r.template_id) || 'content' }));
    }
    const groups = [...new Set(withGroup.map(s => s.variant_group))];
    if (groups.length) {
      const roleByGroup = {};
      for (const s of withGroup) roleByGroup[s.variant_group] = s.role;
      const slideIds = new Set(slides.map(s => s.template_id));
      const placeholders = groups.map(() => '?').join(', ');
      const rows = await db.prepare(
        `SELECT id AS template_id, name AS template_name, html_r2_key, slot_manifest, variant_group
         FROM html_templates
         WHERE variant_group IN (${placeholders}) AND active = TRUE`
      ).all(...groups);
      variants = rows
        .filter(r => !slideIds.has(r.template_id))
        .map(r => ({ ...r, role: roleByGroup[r.variant_group] || 'content' }));
    }
  } catch (err) {
    console.warn('[carouselPackRenderer] variant lookup skipped:', err.message);
  }

  return { pack, slides, variants };
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

  // Archetype-aware planning: if the pack ships typed middle slides (stat,
  // list, quote, comparison, cta), let the planner tag each content slide so
  // it maps to the matching design (buildDeckFromExtract reads `archetype`).
  const CONTENT_CLASS = ['content', 'stat', 'list', 'quote', 'comparison', 'cta'];
  const archetypes = [...new Set(slides.map(s => s.role).filter(r => CONTENT_CLASS.includes(r) && r !== 'content'))];
  const ARCHETYPE_HELP = {
    stat: 'a single big number/metric that lands hard',
    list: 'a short scannable list of points',
    quote: 'a pulled quote or one-line principle',
    comparison: 'a this-vs-that / before-vs-after contrast',
    cta: 'a mid-deck nudge to act',
  };
  const archetypeBlock = archetypes.length
    ? `\nThis pack offers typed slide layouts. For each content slide, add an "archetype" field set to ONE of: ${archetypes.join(', ')} (${archetypes.map(a => `${a} = ${ARCHETYPE_HELP[a] || a}`).join('; ')}). Choose the archetype that fits the idea; use it only where it genuinely suits the content.\n`
    : '';

  // Voice DNA + ICP resonance — same author context every other generation
  // path uses, so carousel copy sounds like the author, not a template.
  let authorContext = '';
  try {
    const profile = await resolveProfile(post.tenant_id);
    if (profile) authorContext = buildSharedAuthorContext(profile) + '\n\n';
  } catch (err) {
    console.warn('[carouselPackRenderer] author context skipped:', err.message);
  }

  const prompt = `${authorContext}Re-plan this LinkedIn post as a swipe-through carousel. Do NOT chop the post into fragments — a carousel is a different rhetorical form: a reader decides at every slide whether to swipe again. Plan the narrative arc first (hook → promise → one idea per slide with rising momentum → payoff), then write each slide for that arc.

COVER SLIDE — generate THREE distinct cover options (different angles: e.g. bold claim, specific number/result, tension or question). Fields for each:
${titleSlots.map(s => `- "${s}": string`).join('\n')}
Cover rules: the main headline field must be 8 words or fewer. It has one job — stop the scroll. No generic labels, no "A guide to…".

CONTENT SLIDES — ${minSlides} to ${maxSlides} slides, ONE idea each:
${contentSlots.map(s => `- "${s}": string`).join('\n')}${archetypeBlock}
Content rules:
- Max 30 words per slide across all fields. Big type, not paragraphs.
- Each slide must earn the next swipe: end on tension, an open loop, or a setup the next slide pays off.
- Keep the author's concrete specifics — numbers, names, outcomes — over abstractions.
- Sequence for momentum: strongest material is the payoff near the end, second-strongest right after the cover.

CLOSING SLIDE — the payoff plus one clear call-to-action or takeaway (max 25 words):
${closingSlots.map(s => `- "${s}": string`).join('\n')}

Voice: write in the author's voice as it sounds in the post below — their phrasing, their energy. No hype words, no "game-changer", nothing that smells like AI.

Return ONLY valid JSON, no markdown fences:
{
  "title_options": [
    { ${titleSlots.map(s => `"${s}": "..."`).join(', ')} },
    { ${titleSlots.map(s => `"${s}": "..."`).join(', ')} },
    { ${titleSlots.map(s => `"${s}": "..."`).join(', ')} }
  ],
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

  // Normalize: the planner returns title_options (3 cover candidates); legacy
  // consumers expect a single `title`. First option is the default cover.
  if (!extracted.title && Array.isArray(extracted.title_options) && extracted.title_options.length) {
    extracted.title = extracted.title_options[0];
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
// Decorations overlay — page numbers, swipe cue, byline
// ---------------------------------------------------------------------------
//
// A single fragment appended before </body> on every slide, so decorations
// work across all templates without re-authoring them. Driven by
// userOverrides.decorations:
//   { pageNumbers: true, swipeCue: true,
//     byline: { name, headline, avatarDataUri } }
// Defaults: no decorations (backward compatible). Page numbers skip the cover
// slide; the swipe cue skips the last slide.

function _escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function appendDecorations(html, deco, slideIndex, totalSlides, dims) {
  const scale = (dims.width || 1080) / 1080;
  const px = n => `${Math.round(n * scale)}px`;
  const isFirst = slideIndex === 0;
  const isLast = slideIndex === totalSlides - 1;

  const pill = `display:flex;align-items:center;gap:${px(10)};background:rgba(0,0,0,0.38);` +
    `color:#fff;border-radius:${px(999)};padding:${px(8)} ${px(18)};` +
    `font:600 ${px(22)}/1.2 Inter,-apple-system,'Segoe UI',sans-serif;letter-spacing:0.01em;`;

  const left = [];
  const right = [];

  if (deco.byline?.enabled !== false && deco.byline?.name) {
    const avatar = (typeof deco.byline.avatarDataUri === 'string' && deco.byline.avatarDataUri.startsWith('data:image/'))
      ? `<img src="${deco.byline.avatarDataUri}" style="width:${px(40)};height:${px(40)};border-radius:50%;object-fit:cover" alt="">`
      : '';
    left.push(`<div style="${pill}">${avatar}<span>${_escapeHtml(deco.byline.name)}</span></div>`);
  }

  if (deco.pageNumbers && !isFirst) {
    right.push(`<div style="${pill}">${slideIndex + 1} / ${totalSlides}</div>`);
  }

  if (deco.swipeCue && !isLast) {
    right.push(`<div style="${pill}">${isFirst ? 'swipe' : ''}&nbsp;&#8594;</div>`);
  }

  if (!left.length && !right.length) return html;

  const overlay =
    `<div data-carousel-decorations style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;` +
    `display:flex;justify-content:space-between;align-items:center;` +
    `padding:${px(28)} ${px(36)};pointer-events:none;">` +
    `<div style="display:flex;gap:${px(12)}">${left.join('')}</div>` +
    `<div style="display:flex;gap:${px(12)}">${right.join('')}</div>` +
    `</div>`;

  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, overlay + '</body>');
  return html + overlay;
}

// ---------------------------------------------------------------------------
// Render a carousel pack
// ---------------------------------------------------------------------------

async function renderCarouselPack(post, packId, userOverrides, brand, ctx) {
  const loaded = await loadPack(packId);
  if (!loaded) throw Object.assign(new Error('pack_not_found'), { status: 404 });

  const { pack, slides } = loaded;
  const variableMap = typeof pack.variable_map === 'string'
    ? JSON.parse(pack.variable_map) : (pack.variable_map || {});

  // Use caller-provided content when present (the extract→render round-trip
  // sends it back, possibly user-edited); only fall back to a fresh AI
  // extraction when the caller sent none.
  const hasProvidedContent = !!(userOverrides &&
    (userOverrides.title || (userOverrides.content_slides || []).length || userOverrides.closing));
  const extracted = hasProvidedContent
    ? userOverrides
    : await extractCarouselPackContent(post, pack, slides);

  // Build ordered slide list: title, content[0..N], closing. Content-class
  // archetypes (stat/list/quote/comparison/cta) count as content templates.
  const CONTENT_CLASS = new Set(['content', 'stat', 'list', 'quote', 'comparison', 'cta']);
  const titleSlides = slides.filter(s => s.role === 'title');
  const contentTemplates = slides.filter(s => CONTENT_CLASS.has(s.role));
  const closingSlides = slides.filter(s => s.role === 'closing');
  const contentByRole = {};
  for (const t of contentTemplates) if (!contentByRole[t.role]) contentByRole[t.role] = t;

  const contentData = extracted.content_slides || [];
  const slideQueue = [];

  // Title
  if (titleSlides.length) {
    slideQueue.push({ slide: titleSlides[0], content: extracted.title || {}, role: 'title' });
  }

  // Content slides — honor the planner's archetype hint, else round-robin
  for (let i = 0; i < contentData.length; i++) {
    const data = contentData[i] || {};
    const hinted = typeof data.archetype === 'string' ? contentByRole[data.archetype] : null;
    const tpl = hinted || contentTemplates[i % contentTemplates.length] || contentTemplates[0];
    if (tpl) {
      const { archetype, ...slotData } = data;
      slideQueue.push({ slide: tpl, content: slotData, role: tpl.role });
    }
  }

  // Closing
  if (closingSlides.length) {
    slideQueue.push({ slide: closingSlides[0], content: extracted.closing || {}, role: 'closing' });
  }

  const { slides: slideResults, pdf_url: pdfUrl } =
    await _renderSlideQueue(post, variableMap, slideQueue, userOverrides, brand, ctx);

  return { slides: slideResults, pdf_url: pdfUrl, content: extracted };
}

// ---------------------------------------------------------------------------
// Shared slide-queue renderer — used by both the legacy pack path and the
// Studio deck path.
// ---------------------------------------------------------------------------

async function _renderSlideQueue(post, variableMap, slideQueue, userOverrides, brand, ctx) {
  const { userId, tenantId } = ctx;

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
    let finalHtml = injectSlots(html, allSlots);

    // Decorations overlay (page numbers / swipe cue / byline), if requested
    if (userOverrides?.decorations) {
      finalHtml = appendDecorations(finalHtml, userOverrides.decorations, i, total, dims);
    }

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

  return { slides: slideResults, pdf_url: pdfUrl };
}

// ---------------------------------------------------------------------------
// Render a Studio deck (carousel_drafts.deck) — content, order, theme, and
// decorations all come from the deck document, not from AI extraction.
// ---------------------------------------------------------------------------

async function renderCarouselDeck(post, deck, brand, ctx) {
  const loaded = await loadPack(deck.pack_id);
  if (!loaded) throw Object.assign(new Error('pack_not_found'), { status: 404 });

  const { pack, slides, variants } = loaded;
  const variableMap = typeof pack.variable_map === 'string'
    ? JSON.parse(pack.variable_map) : (pack.variable_map || {});

  const templatesById = new Map([...slides, ...(variants || [])].map(s => [s.template_id, s]));

  const slideQueue = (deck.slides || []).map(ds => {
    const tpl = templatesById.get(ds.template_id);
    if (!tpl) throw Object.assign(new Error('slide_template_not_in_pack'), { status: 400 });
    return { slide: tpl, content: ds.slots || {}, role: ds.role };
  });
  if (!slideQueue.length) throw Object.assign(new Error('deck_has_no_slides'), { status: 400 });

  // Resolve decorations: byline pulls the workspace's default LinkedIn
  // identity (cached avatar → data URI) unless the deck supplies a name.
  const settings = deck.settings || {};
  const deco = settings.decorations || {};
  let decorations = null;
  if (deco.pageNumbers || deco.swipeCue || deco.byline?.enabled) {
    decorations = { pageNumbers: !!deco.pageNumbers, swipeCue: !!deco.swipeCue };
    if (deco.byline?.enabled) {
      let name = (deco.byline.name || '').trim();
      let avatarDataUri = null;
      try {
        const li = await db.prepare(
          'SELECT display_name, avatar_url FROM linkedin_connections WHERE workspace_id = ? AND is_default = true'
        ).get(ctx.tenantId);
        if (!name && li?.display_name) name = li.display_name.trim();
        if (li?.avatar_url) avatarDataUri = await loadLinkedInAvatarDataUri(li.avatar_url);
      } catch (err) {
        console.warn('[carouselPackRenderer] byline lookup failed (non-fatal):', err.message);
      }
      if (name) decorations.byline = { enabled: true, name, avatarDataUri };
    }
  }

  const userOverrides = {
    colors: settings.theme?.colors || {},
    decorations,
  };

  const { slides: slideResults, pdf_url: pdfUrl } =
    await _renderSlideQueue(post, variableMap, slideQueue, userOverrides, brand, ctx);

  return { slides: slideResults, pdf_url: pdfUrl };
}

function startCarouselDeckJob(jobId, post, deck, brand, ctx) {
  renderJobs.set(jobId, {
    status: 'rendering',
    progress: { current: 0, total: 0 },
    slides: [],
    pdf_url: null,
    error: null,
    createdAt: Date.now(),
  });
  _setJob(jobId, { status: 'rendering', progress: { current: 0, total: 0 }, slides: [], pdf_url: null, error: null });

  renderCarouselDeck(post, deck, brand, { ...ctx, _jobId: jobId })
    .then(result => {
      _setJob(jobId, {
        status: 'done',
        progress: { current: result.slides.length, total: result.slides.length },
        slides: result.slides,
        pdf_url: result.pdf_url,
        error: null,
      });
    })
    .catch(err => {
      console.error('[carouselPackRenderer] deck job %s failed:', jobId, err.message);
      _setJob(jobId, { status: 'failed', slides: [], pdf_url: null, error: err.message });
    });
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
  renderCarouselDeck,
  startCarouselPackJob,
  startCarouselDeckJob,
  getCarouselJobStatus,
  appendDecorations,
  loadPack,
};

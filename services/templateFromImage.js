'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const { extractJsonFromResponse, getAnthropicMessageText } = require('./voiceFingerprint');
const sharp = require('sharp');

let _callRenderService = null;
function getRenderService() {
  if (!_callRenderService) {
    _callRenderService = require('./templateRenderer').callRenderService;
  }
  return _callRenderService;
}

// ---------------------------------------------------------------------------
// Pass 1 prompt — generate HTML from image
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert HTML/CSS developer converting design images into Puppeteer-compatible HTML templates.

OUTPUT: Return a JSON object with exactly two keys:
{ "html": "<!DOCTYPE html>...", "manifest": { "slots": {...}, "dimensions": {...} } }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — ANALYZE THE IMAGE FIRST (before generating any code)

Before writing HTML, mentally catalog:
A) COLORS: List every distinct color (background, text, accents, borders). Assign a CSS var name to each:
   --bg, --accent, --text, --text-muted, --border, --card-bg, etc.
B) TYPOGRAPHY: Is it serif or sans-serif? Condensed? Bold/light weights? Pick the closest Google Font.
C) BACKGROUND TYPE: Solid color | CSS gradient | Image/pattern?
   - If gradient: note direction (to bottom right, 135deg, etc.) and all color stops.
D) LAYOUT: Flexbox column | Flexbox row | CSS Grid | Layered (position:absolute)?
E) ASPECT RATIO: Square (1080×1080) | Portrait (1080×1350) | Landscape (1200×628)?
F) EDITABLE REGIONS: Which text blocks should be slots? Which images?
G) DECORATIVE ELEMENTS: Lines, shapes, icons, badges — reproduce as inline SVG.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — GENERATE THE HTML TEMPLATE

RULE 1: LAYOUT
   - Root container: <div> with explicit width and height in px, overflow:hidden.
   - Use Flexbox or CSS Grid as primary layout. You MAY use position:absolute for decorative overlays, badges, or layered elements when the design requires it.
   - Use inline SVG for shapes, icons, dividers, and decorative elements — reproduce them faithfully.

RULE 2: FONTS
   - Load via <link href="https://fonts.googleapis.com/css2?family=...&display=swap">.
   - Pick the closest Google Font. Good options: Poppins, Inter, Montserrat, Playfair Display, Raleway, Roboto Condensed, DM Sans, Space Grotesk.
   - Always specify font-weight explicitly (400, 500, 600, 700, 800).

RULE 3: COLORS — NON-NEGOTIABLE
   WRONG ✗ (hardcoded hex in CSS rule):
     .headline { color: #1a1a2e; }
     <p style="color:#e94560">...</p>

   RIGHT ✓ (CSS custom property on root, var() everywhere else):
     <div style="--bg:#1a1a2e; --accent:#e94560; --text:#ffffff; --text-muted:rgba(255,255,255,0.7)">
     .headline { color: var(--text); }
     .badge { background: var(--accent); }

   RULES:
   - ALL color hex values (#rrggbb or rgba()) MUST be in the root container's style="" attribute as CSS custom properties.
   - In EVERY CSS rule and inline style on child elements: use var(--name) ONLY. Never repeat a hex value.
   - One CSS custom property per distinct color. If two elements share a color, they share a var().
   - Add a "color:varname" entry in the manifest for EVERY CSS custom property you define.

RULE 4: TEXT SLOTS — Mark editable text with data-slot="key_name":
   <h1 data-slot="headline">Compelling Headline Here</h1>
   Use snake_case keys. Include realistic placeholder text that matches the image content.

RULE 5: IMAGE SLOTS — MUST follow this exact pattern:
   <img data-slot="image:photo" src="" alt="Photo description">
   - Key MUST start with "image:" prefix (e.g. image:photo, image:portrait, image:logo)
   - src MUST be empty string "" — the original photo will be cropped and injected automatically
   - Do NOT put data-slot-container on image parent elements — that is ONLY for repeating slots
   - In the manifest, include the bounding box of the image area in template pixel coordinates:
     "image:photo": { "x": 60, "y": 120, "w": 400, "h": 500 }
   - x, y = top-left corner of the image within the template (in px from top-left of root div)
   - w, h = width and height of the image area (in px)
   - Estimate carefully by analyzing where the photo/image appears in the design.

RULE 6: REPEATING SLOTS — ONLY for lists, steps, or grids of similar items:
   <div data-slot="items" data-slot-container>
     <div data-slot-item>
       <h3 data-slot-field="title">Title</h3>
       <p data-slot-field="body">Body</p>
     </div>
   </div>
   - data-slot-container is ONLY for repeated content groups, NEVER for single images or text
   - Include 2-3 example items with realistic content from the image.

RULE 7: MANIFEST — Embed inside <head>:
   <script type="application/json" id="template-meta">
   {"slots":{"headline":{"maxLen":80},"subtext":{"maxLen":200},"color:bg":{"default":"#1a1a2e"},"color:accent":{"default":"#e94560"},"color:text":{"default":"#ffffff"},"color:text_muted":{"default":"rgba(255,255,255,0.7)"},"image:photo":{"x":60,"y":120,"w":400,"h":500},"items":{"type":"repeating","fields":["title","body"],"min":2,"max":6}},"dimensions":{"width":1080,"height":1080}}
   </script>
   - Include ALL color:* slots — one per CSS custom property defined
   - Include ALL image:* slots with bounding box { "x":..., "y":..., "w":..., "h":... }
   - Include ALL text slots with appropriate maxLen

RULE 8: VISUAL FIDELITY
   - Match the image's padding, margins, and spacing precisely.
   - Reproduce font sizes: large headings 36-64px, subheadings 20-28px, body 14-18px.
   - Line-height: 1.1-1.2 for headings, 1.4-1.6 for body.
   - Letter-spacing: tight (-1px to -2.5px) for large headings if the design uses it.
   - Reproduce rounded corners, shadows, and decorative elements precisely.
   - For gradient backgrounds: use CSS linear-gradient() or radial-gradient() — match direction and all color stops exactly. Store each gradient stop color as a separate CSS var.
   - For pattern/texture backgrounds: approximate with CSS gradients or SVG patterns.
   - Reproduce decorative lines, shapes, and icons as inline SVG.

RULE 9: DIMENSIONS — Match the image aspect ratio:
   Square: 1080×1080 | Portrait: 1080×1350 | Landscape: 1200×628

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3 — SELF-CHECK BEFORE OUTPUTTING

Before returning, verify:
□ Every hex color in the template appears ONLY in the root container's style=""
□ Every CSS rule uses var(--name), never a literal hex value
□ Every image element has data-slot="image:key" (with "image:" prefix) and src=""
□ Every image:* slot in the manifest has x, y, w, h bounding box coordinates
□ The manifest lists color:* for every CSS var defined
□ No data-slot-container on non-repeating elements

CRITICAL: Return ONLY the raw JSON. No markdown fences, no explanation.`;

const SVG_SYSTEM_PROMPT = `You are an expert HTML/CSS developer converting an SVG design into a Puppeteer-compatible HTML template.

You are given the SVG source code of a design. Extract EXACT values from the SVG:
- font-family attributes → use those exact fonts (load via Google Fonts <link>)
- fill/stroke hex colors → use those exact hex values as CSS custom properties
- viewBox/width/height → use for template dimensions
- text elements → make editable with data-slot attributes
- <image> elements with embedded base64 data → PRESERVE as image slots with the original data

OUTPUT: Return a JSON object: { "html": "<!DOCTYPE html>...", "manifest": { "slots": {...}, "dimensions": {...} } }

RULES:
1. Root <div> with explicit width/height and overflow:hidden
2. ALL colors as CSS custom properties on root: style="--bg:#hex; --accent:#hex; --text:#hex"
3. Text slots: data-slot="key_name" with snake_case keys
4. Image slots: data-slot="image:key" — if the SVG contains a <image> element with href="data:image/..." (base64 embedded image), PRESERVE that data URI as the src value:
   <img data-slot="image:photo" src="data:image/png;base64,..." alt="Photo">
   This keeps the original image as a default that users can optionally replace.
   If the image href is an external URL, also preserve it as the src value.
   Only use src="" if there is no image data to preserve.
5. Repeating slots: data-slot-container + data-slot-item + data-slot-field
6. Embed manifest as <script type="application/json" id="template-meta"> in <head>
7. Include color:* slots in manifest for each CSS variable

ADVANTAGE: You have the exact SVG source — use the EXACT font-family, EXACT hex colors, EXACT dimensions, and PRESERVE embedded images. Do not approximate anything.

CRITICAL: Return ONLY the raw JSON. No markdown fences, no explanation.`;

// ---------------------------------------------------------------------------
// Pass 2 prompt — refine HTML by comparing original vs rendered
// ---------------------------------------------------------------------------

const REFINE_PROMPT = `You are refining an HTML template to match a design image more precisely.

Image 1 is the ORIGINAL DESIGN (the target to match).
Image 2 is the CURRENT HTML RENDERING (what the code produces now).

STEP 1 — DIFF: Note every visible difference between Image 1 and Image 2:
- Colors that don't match (background, text, accents)
- Font size or weight mismatches
- Spacing or padding differences
- Missing decorative elements (lines, shapes, icons)
- Text alignment differences
- Missing or incorrectly placed image areas
- Any element in Image 1 absent from Image 2

STEP 2 — FIX ALL DIFFERENCES:
- Background colors: match the exact hex values from Image 1
- Font sizes, weights, line-heights: match precisely
- Spacing and padding: adjust to match Image 1 layout
- Typography: if the font doesn't look right, try a different Google Font
- Decorative elements: add missing shapes, lines, icons as inline SVG
- Text alignment: left/center/right must match Image 1
- Image placement and sizing: match Image 1 proportions

STEP 3 — COLOR AUDIT (MANDATORY):
Scan every CSS rule and inline style in the HTML. If you find ANY hardcoded hex value (#rrggbb) or rgba() color outside of the root container's style="" attribute:
1. Add it as a CSS custom property on the root container (--new_var:#hex)
2. Replace the hardcoded value with var(--new_var)
3. Add "color:new_var" to the manifest slots with its default hex value

INVIOLABLE RULES:
- Keep ALL data-slot, data-slot-container, data-slot-item, data-slot-field attributes exactly as they are — do NOT modify slot keys or remove slot attributes
- Keep the <script type="application/json" id="template-meta"> block — you may ADD new color:* entries but do NOT remove existing slots or change their keys
- Keep all Google Font <link> tags in <head>
- Return the COMPLETE corrected HTML document (not a JSON wrapper — just raw HTML starting with <!DOCTYPE html>)
- No markdown fences, no explanation — only the HTML`;

const VISION_TIMEOUT_MS = 90_000;

async function generateTemplateFromImage(imageBuffer, options = {}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  // Detect SVG input
  const bufStr = imageBuffer.toString('utf8', 0, Math.min(200, imageBuffer.length));
  const isSvg = options.contentType === 'image/svg+xml' || bufStr.trimStart().startsWith('<svg') || bufStr.trimStart().startsWith('<?xml');

  let imageBlock, mimeType, originalMeta;

  const SVG_TEXT_MAX_BYTES = 80_000; // ~20K tokens — safe for text pipeline

  if (isSvg && imageBuffer.length <= SVG_TEXT_MAX_BYTES) {
    // Small SVG: use text-based pipeline (exact fonts/colors from markup)
    console.log('[templateFromImage] SVG text pipeline (%d bytes)', imageBuffer.length);
    mimeType = 'image/svg+xml';
    imageBlock = null;
  } else if (isSvg) {
    // Large SVG (Canva exports with embedded images): render to PNG, use Vision
    console.log('[templateFromImage] SVG too large for text (%d bytes), converting to PNG', imageBuffer.length);
    try {
      const pngBuf = await sharp(imageBuffer).png().toBuffer();
      const meta = await sharp(pngBuf).metadata();
      let resizedBuf = pngBuf;
      if (meta.width > 2048 || meta.height > 2048) {
        resizedBuf = await sharp(pngBuf).resize(2048, 2048, { fit: 'inside' }).toBuffer();
      }
      imageBlock = {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: resizedBuf.toString('base64') },
        cache_control: { type: 'ephemeral' },
      };
      mimeType = 'image/png';
      console.log('[templateFromImage] SVG→PNG: %d bytes', resizedBuf.length);
    } catch (err) {
      throw new Error('Could not render SVG — the file may be too complex or corrupted');
    }
  } else {
    let meta;
    try {
      meta = await sharp(imageBuffer).metadata();
    } catch (err) {
      throw new Error('Invalid image file — could not read image metadata');
    }

    if (!meta.format || !['png', 'jpeg', 'jpg', 'webp', 'gif', 'tiff'].includes(meta.format)) {
      throw new Error(`Unsupported image format: ${meta.format || 'unknown'}`);
    }

    originalMeta = meta; // capture before any resize — used for image cropping later

    mimeType = meta.format === 'png' ? 'image/png'
             : meta.format === 'webp' ? 'image/webp'
             : 'image/jpeg';

    let resizedBuf = imageBuffer;
    if (meta.width > 2048 || meta.height > 2048) {
      resizedBuf = await sharp(imageBuffer).resize(2048, 2048, { fit: 'inside' }).toBuffer();
    }
    const base64 = resizedBuf.toString('base64');

    imageBlock = {
      type: 'image',
      source: { type: 'base64', media_type: mimeType, data: base64 },
      cache_control: { type: 'ephemeral' },
    };
  }

  const client = new Anthropic({ apiKey });

  const callWithTimeout = (params) => {
    return Promise.race([
      client.messages.create(params),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AI conversion timed out after 90 seconds')), VISION_TIMEOUT_MS)
      ),
    ]);
  };

  // ── Pass 1: Design → HTML ────────────────────────────────────────────────

  const pass1Start = Date.now();
  let pass1Messages, pass1System;

  const useSvgTextPipeline = isSvg && !imageBlock;

  if (useSvgTextPipeline) {
    console.log('[templateFromImage] pass 1: generating HTML from SVG (text-based)');
    const svgText = imageBuffer.toString('utf8');
    const svgPrompt = options.instructions
      ? `Convert this SVG design into an HTML template. Additional instructions: ${options.instructions}\n\nSVG SOURCE:\n${svgText}`
      : `Convert this SVG design into an HTML template. Use the EXACT font-family, fill colors, and dimensions from the SVG.\n\nSVG SOURCE:\n${svgText}`;
    pass1System = SVG_SYSTEM_PROMPT;
    pass1Messages = [{ role: 'user', content: svgPrompt }];
  } else {
    console.log('[templateFromImage] pass 1: generating HTML from image (Vision)');
    const userPrompt = options.instructions
      ? `Convert this design image into an HTML template. Additional instructions: ${options.instructions}`
      : 'Convert this design image into an HTML template. Reproduce the layout, typography, colors, and structure as closely as possible.';
    pass1System = SYSTEM_PROMPT;
    pass1Messages = [{ role: 'user', content: [imageBlock, { type: 'text', text: userPrompt }] }];
  }

  const msg = await callWithTimeout({
    model: 'claude-sonnet-4-6',
    max_tokens: 12000,
    system: pass1System,
    messages: pass1Messages,
  });

  const rawText = getAnthropicMessageText(msg);

  let result;
  try {
    result = extractJsonFromResponse(rawText);
  } catch (e) {
    const retryMessages = [
      ...pass1Messages,
      { role: 'assistant', content: msg.content },
      { role: 'user', content: 'Return only the JSON object with "html" and "manifest" keys. No markdown, no code fences.' },
    ];
    const retry = await callWithTimeout({
      model: 'claude-sonnet-4-6',
      max_tokens: 12000,
      system: pass1System,
      messages: retryMessages,
    });
    result = extractJsonFromResponse(getAnthropicMessageText(retry));
  }

  if (!result.html || typeof result.html !== 'string') {
    throw new Error('AI did not return valid HTML — please try again');
  }

  const manifest = result.manifest || { slots: {}, dimensions: { width: 1080, height: 1080 } };
  if (!manifest.slots) manifest.slots = {};
  if (!manifest.dimensions) manifest.dimensions = { width: 1080, height: 1080 };

  let html = result.html;

  // ── Post-processing: fix common Claude mistakes ─────────────────────────

  // Fix <img> tags with data-slot missing "image:" prefix
  // Handles multi-line attributes (Claude often puts each attr on its own line)
  html = html.replace(/<img\b([^>]*?)data-slot="(?!image:)([\w]+)"([^>]*?)>/gs, (match, before, key, after) => {
    console.log('[templateFromImage] fixing image slot: %s → image:%s', key, key);
    manifest.slots[`image:${key}`] = manifest.slots[key] || {};
    delete manifest.slots[key];
    // Also fix src — clear non-data-URI filenames
    let fixed = `<img${before}data-slot="image:${key}"${after}>`;
    fixed = fixed.replace(/src="(?!data:)[^"]*"/g, 'src=""');
    return fixed;
  });

  // Fix remaining image slots with filename src (already have image: prefix)
  html = html.replace(/(<img\b[^>]*data-slot="image:[^"]*"[^>]*?)src="(?!data:)[^"]*"/gs, '$1src=""');

  // Remove bogus data-slot-container on non-repeating elements
  html = html.replace(/data-slot-container="[^"]*"/g, 'data-slot-container');

  // Sync manifest: ensure all data-slot keys in HTML exist in manifest
  const slotMatches = html.matchAll(/data-slot="([^"]+)"/g);
  for (const m of slotMatches) {
    const key = m[1];
    if (key === 'data-slot-container' || key === 'data-slot-item') continue;
    if (!manifest.slots[key]) {
      if (key.startsWith('image:')) manifest.slots[key] = {};
      else manifest.slots[key] = { maxLen: 200 };
    }
  }

  console.log('[templateFromImage] pass 1 done in %dms (%d bytes, %d slots)',
    Date.now() - pass1Start, html.length, Object.keys(manifest.slots).length);

  // ── Pass 2: Render → Compare → Refine ──────────────────────────────────

  const shouldRefine = options.refine !== false;

  if (shouldRefine) {
    try {
      const callRenderService = getRenderService();
      const { width = 1080, height = 1080 } = manifest.dimensions;

      console.log('[templateFromImage] pass 2: rendering HTML for comparison (%dx%d)', width, height);
      const pass2Start = Date.now();

      const renderedPng = await callRenderService(html, width, height);
      const renderedBase64 = renderedPng.toString('base64');

      console.log('[templateFromImage] pass 2: rendered in %dms (%d bytes PNG), sending for refinement',
        Date.now() - pass2Start, renderedPng.length);

      const refineMsg = await callWithTimeout({
        model: 'claude-sonnet-4-6',
        max_tokens: 12000,
        system: REFINE_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Image 1 — Original design:' },
            imageBlock,
            { type: 'text', text: 'Image 2 — Current HTML rendering:' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: renderedBase64 } },
            { type: 'text', text: 'Return the complete corrected HTML document. Keep all data-slot attributes and the template-meta script block intact.' },
          ],
        }],
      });

      const refinedText = getAnthropicMessageText(refineMsg);

      // Extract raw HTML — strip markdown fences if present
      let refinedHtml = refinedText.trim()
        .replace(/^```(?:html)?\s*/m, '')
        .replace(/\s*```\s*$/m, '')
        .trim();

      if (refinedHtml.includes('<!DOCTYPE') || refinedHtml.includes('<html')) {
        html = refinedHtml;
        console.log('[templateFromImage] pass 2 refinement applied (%d bytes, total %dms)',
          html.length, Date.now() - pass2Start);
      } else {
        console.warn('[templateFromImage] pass 2 refinement skipped — response did not contain valid HTML');
      }
    } catch (err) {
      console.warn('[templateFromImage] pass 2 refinement failed (using pass 1 result):', err.message);
    }
  }

  // ── Pass 3: Crop original photos and embed as default images ─────────────
  // Only for Vision path (not SVG text pipeline — SVG already preserves images)
  if (!useSvgTextPipeline && originalMeta) {
    try {
      html = await injectCroppedImages(html, manifest, imageBuffer, originalMeta);
    } catch (err) {
      console.warn('[templateFromImage] image injection failed:', err.message);
    }
  }

  return { html, manifest };
}

// ---------------------------------------------------------------------------
// Crop image regions from the original design and inject as default src values.
// Claude provides bounding boxes (x,y,w,h) in template coordinates; we scale
// them to the original image pixel space and crop with Sharp.
// ---------------------------------------------------------------------------

async function injectCroppedImages(html, manifest, imageBuffer, originalMeta) {
  const { width: tplW, height: tplH } = manifest.dimensions;
  const { width: origW, height: origH } = originalMeta;
  if (!origW || !origH || !tplW || !tplH) return html;

  const scaleX = origW / tplW;
  const scaleY = origH / tplH;

  for (const [key, cfg] of Object.entries(manifest.slots)) {
    if (!key.startsWith('image:')) continue;
    if (cfg.x == null || cfg.y == null || cfg.w == null || cfg.h == null) {
      console.log('[templateFromImage] no bbox for %s — skipping crop', key);
      continue;
    }

    const left   = Math.max(0, Math.round(cfg.x * scaleX));
    const top    = Math.max(0, Math.round(cfg.y * scaleY));
    const width  = Math.min(Math.round(cfg.w * scaleX), origW - left);
    const height = Math.min(Math.round(cfg.h * scaleY), origH - top);

    if (width < 10 || height < 10) {
      console.warn('[templateFromImage] crop too small for %s (%dx%d), skipping', key, width, height);
      continue;
    }

    try {
      const cropped = await sharp(imageBuffer)
        .extract({ left, top, width, height })
        .resize({ width: Math.min(Math.round(cfg.w), 1200), height: Math.min(Math.round(cfg.h), 1200), fit: 'inside' })
        .jpeg({ quality: 85 })
        .toBuffer();

      const dataUri = `data:image/jpeg;base64,${cropped.toString('base64')}`;
      // Escape the slot key for use in a regex (colons are fine but be safe)
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Replace src="" on <img data-slot="image:key"> — attribute order may vary
      const beforeAttr = new RegExp(`(<img\\b[^>]*?data-slot="${escapedKey}"[^>]*?)src=""`, 'gs');
      const afterAttr  = new RegExp(`(<img\\b[^>]*?)src=""([^>]*?data-slot="${escapedKey}"[^>]*?>)`, 'gs');
      const prevLen = html.length;
      html = html.replace(beforeAttr, `$1src="${dataUri}"`);
      html = html.replace(afterAttr, `$1src="${dataUri}"$2`);

      if (html.length !== prevLen) {
        console.log('[templateFromImage] injected default image for %s (%dx%d, %d bytes JPEG)',
          key, width, height, cropped.length);
      } else {
        console.warn('[templateFromImage] could not find img[data-slot="%s"] with src="" to inject into', key);
      }
    } catch (err) {
      console.warn('[templateFromImage] crop failed for %s:', key, err.message);
    }
  }

  return html;
}

module.exports = { generateTemplateFromImage };

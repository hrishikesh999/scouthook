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

RULES:

1. LAYOUT
   - Root container: <div> with explicit width and height in px, overflow:hidden.
   - Use Flexbox or CSS Grid as primary layout. You MAY use position:absolute for decorative overlays, badges, or layered elements when the design requires it.
   - Use inline SVG for shapes, icons, dividers, and decorative elements — reproduce them faithfully.

2. FONTS
   - Load via <link href="https://fonts.googleapis.com/css2?family=...&display=swap">.
   - Study the image carefully: is it serif or sans-serif? Condensed or regular? Bold or light?
   - Pick the closest Google Font. Good options: Poppins, Inter, Montserrat, Playfair Display, Raleway, Roboto Condensed, DM Sans, Space Grotesk.
   - Always specify font-weight explicitly (400, 500, 600, 700, 800).

3. COLORS — CRITICAL
   - Extract exact hex colors from the image.
   - ALL colors MUST be CSS custom properties on the root container style attribute:
     style="--bg:#1a1a2e; --accent:#e94560; --text:#ffffff; --text-muted:rgba(255,255,255,0.7)"
   - In ALL CSS rules, ALWAYS use var(--bg), var(--accent), var(--text) etc. NEVER hardcode hex colors in CSS rules or inline styles on child elements. The root container style is the ONLY place hex values appear.
   - Add a "color:varname" entry in the manifest for each CSS variable.

4. TEXT SLOTS — Mark editable text with data-slot="key_name":
   <h1 data-slot="headline">Headline</h1>
   Use snake_case keys. Include realistic placeholder text that matches the image content.

5. IMAGE SLOTS — MUST follow this exact pattern:
   <img data-slot="image:photo" src="" alt="Photo description">
   - Key MUST start with "image:" prefix (e.g. image:photo, image:portrait, image:logo)
   - src MUST be empty string "" — NEVER a filename like "photo.jpg"
   - Do NOT put data-slot-container on image parent elements — that is ONLY for repeating slots
   - In the manifest, use "image:photo": {}

6. REPEATING SLOTS — ONLY for lists, steps, or grids of similar items:
   <div data-slot="items" data-slot-container>
     <div data-slot-item>
       <h3 data-slot-field="title">Title</h3>
       <p data-slot-field="body">Body</p>
     </div>
   </div>
   - data-slot-container is ONLY for repeated content groups, NEVER for single images or text
   - Include 2-3 example items with realistic content from the image.

7. MANIFEST — Embed inside <head>:
   <script type="application/json" id="template-meta">
   {"slots":{"headline":{"maxLen":80},"color:bg":{"default":"#1a1a2e"},"color:accent":{"default":"#e94560"},"color:text":{"default":"#ffffff"},"image:photo":{},"items":{"type":"repeating","fields":["title","body"],"min":2,"max":6}},"dimensions":{"width":1080,"height":1080}}
   </script>
   - Include ALL color:* slots matching the CSS variables
   - Include ALL image:* slots with empty config {}
   - Include ALL text slots with appropriate maxLen

8. VISUAL FIDELITY
   - Match the image's padding, margins, and spacing precisely.
   - Reproduce font sizes: large headings 36-56px, subheadings 20-28px, body 14-18px.
   - Line-height: 1.1-1.2 for headings, 1.4-1.6 for body.
   - Letter-spacing: tight (-1px to -2.5px) for large headings if the design uses it.
   - Reproduce rounded corners, shadows, gradients, and decorative elements.
   - Use CSS gradients for gradient backgrounds — match direction and color stops.
   - Ensure high contrast between text and background.

9. DIMENSIONS — Match the image aspect ratio:
   Square: 1080x1080 | Portrait: 1080x1350 | Landscape: 1200x628

COMMON MISTAKES TO AVOID:
- Using data-slot="portrait" for images — MUST be data-slot="image:portrait"
- Setting src="photo.jpg" on image slots — MUST be src=""
- Putting data-slot-container on image wrappers — ONLY for repeating content
- Hardcoding hex colors in CSS rules — MUST use var() everywhere
- Forgetting color:* slots in the manifest

CRITICAL: Return ONLY the raw JSON. No markdown fences, no explanation.`;

const SVG_SYSTEM_PROMPT = `You are an expert HTML/CSS developer converting an SVG design into a Puppeteer-compatible HTML template.

You are given the SVG source code of a design. Extract EXACT values from the SVG:
- font-family attributes → use those exact fonts (load via Google Fonts <link>)
- fill/stroke hex colors → use those exact hex values as CSS custom properties
- viewBox/width/height → use for template dimensions
- text elements → make editable with data-slot attributes
- image/rect elements → identify image slots

OUTPUT: Return a JSON object: { "html": "<!DOCTYPE html>...", "manifest": { "slots": {...}, "dimensions": {...} } }

Follow ALL the same rules as for image conversion:
1. Root <div> with explicit width/height and overflow:hidden
2. ALL colors as CSS custom properties on root: style="--bg:#hex; --accent:#hex; --text:#hex"
3. Text slots: data-slot="key_name" with snake_case keys
4. Image slots: data-slot="image:key" with src=""
5. Repeating slots: data-slot-container + data-slot-item + data-slot-field
6. Embed manifest as <script type="application/json" id="template-meta"> in <head>
7. Include color:* slots in manifest for each CSS variable

ADVANTAGE: You have the exact SVG source — use the EXACT font-family, EXACT hex colors, and EXACT dimensions. Do not approximate.

CRITICAL: Return ONLY the raw JSON. No markdown fences, no explanation.`;

// ---------------------------------------------------------------------------
// Pass 2 prompt — refine HTML by comparing original vs rendered
// ---------------------------------------------------------------------------

const REFINE_PROMPT = `You are refining an HTML template to match a design image more precisely.

Image 1 is the ORIGINAL DESIGN (the target to match).
Image 2 is the CURRENT HTML RENDERING (what the code produces now).

Compare them carefully and fix ALL differences:
- Background colors: match the exact hex values from the original
- Font sizes, weights, and line-heights: match the original precisely
- Spacing and padding: adjust to match the original layout
- Typography: if the font doesn't match, try a different Google Font
- Decorative elements: add missing shapes, lines, icons as inline SVG
- Text alignment: left/center/right must match the original
- Image placement and sizing: match the original proportions
- Any visual element present in Image 1 but missing in Image 2 must be added

CRITICAL RULES:
- Keep ALL data-slot, data-slot-container, data-slot-item, data-slot-field attributes exactly as they are
- Keep the <script type="application/json" id="template-meta"> block unchanged
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

  let imageBlock, mimeType;

  if (isSvg) {
    // SVG: use text-based pipeline (no Vision needed)
    console.log('[templateFromImage] detected SVG input (%d bytes)', imageBuffer.length);
    mimeType = 'image/svg+xml';
    imageBlock = null; // will use text message instead
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

  if (isSvg) {
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

  // Fix image slots missing "image:" prefix
  html = html.replace(/data-slot="(?!image:)([\w]+)"\s*(src\s*=\s*"[^"]*")/g, (match, key, srcAttr) => {
    if (srcAttr.includes('src=')) {
      console.log('[templateFromImage] fixing image slot: %s → image:%s', key, key);
      manifest.slots[`image:${key}`] = manifest.slots[key] || {};
      delete manifest.slots[key];
      return `data-slot="image:${key}" src=""`;
    }
    return match;
  });

  // Fix image src that has a filename instead of empty string
  html = html.replace(/(data-slot="image:[^"]+"\s+)src="(?!data:)[^"]+"/g, '$1src=""');

  // Remove bogus data-slot-container on non-repeating elements
  html = html.replace(/data-slot-container="[^"]*"/g, (match) => {
    return 'data-slot-container';
  });

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

  return { html, manifest };
}

module.exports = { generateTemplateFromImage };

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

const SYSTEM_PROMPT = `You are an expert HTML/CSS developer who converts design images into pixel-perfect, Puppeteer-compatible HTML templates.

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

3. COLORS
   - Extract exact hex colors from the image — be precise, not approximate.
   - Define as CSS custom properties on the root container style attribute:
     style="--bg:#1a1a2e; --accent:#e94560; --text:#ffffff; --text-muted:rgba(255,255,255,0.7)"
   - Use var(--bg), var(--accent), etc. everywhere. This enables user color customization.

4. TEXT SLOTS — Mark editable text with data-slot="key_name":
   <h1 data-slot="headline">Headline</h1>
   Use snake_case keys. Include realistic placeholder text that matches the image content.

5. IMAGE SLOTS — For uploadable images, key starts with "image:":
   <img data-slot="image:photo" src="" alt="" style="width:100%;height:200px;object-fit:cover;border-radius:12px">

6. REPEATING SLOTS — For lists/steps/items:
   <div data-slot="items" data-slot-container>
     <div data-slot-item>
       <h3 data-slot-field="title">Title</h3>
       <p data-slot-field="body">Body</p>
     </div>
   </div>
   Include 2-3 example items with realistic content from the image.

7. MANIFEST — Embed in the HTML:
   <script type="application/json" id="template-meta">
   {"slots":{"headline":{"maxLen":80},"color:accent":{"default":"#e94560"},"image:photo":{},"items":{"type":"repeating","fields":["title","body"],"min":2,"max":6}},"dimensions":{"width":1080,"height":1080}}
   </script>

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

  let meta;
  try {
    meta = await sharp(imageBuffer).metadata();
  } catch (err) {
    throw new Error('Invalid image file — could not read image metadata');
  }

  if (!meta.format || !['png', 'jpeg', 'jpg', 'webp', 'gif', 'tiff'].includes(meta.format)) {
    throw new Error(`Unsupported image format: ${meta.format || 'unknown'}`);
  }

  const mimeType = meta.format === 'png' ? 'image/png'
                 : meta.format === 'webp' ? 'image/webp'
                 : 'image/jpeg';

  let resizedBuf = imageBuffer;
  if (meta.width > 2048 || meta.height > 2048) {
    resizedBuf = await sharp(imageBuffer).resize(2048, 2048, { fit: 'inside' }).toBuffer();
  }
  const base64 = resizedBuf.toString('base64');

  const userPrompt = options.instructions
    ? `Convert this design image into an HTML template. Additional instructions: ${options.instructions}`
    : 'Convert this design image into an HTML template. Reproduce the layout, typography, colors, and structure as closely as possible.';

  const imageBlock = {
    type: 'image',
    source: { type: 'base64', media_type: mimeType, data: base64 },
    cache_control: { type: 'ephemeral' },
  };

  const client = new Anthropic({ apiKey });

  const callWithTimeout = (params) => {
    return Promise.race([
      client.messages.create(params),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AI conversion timed out after 90 seconds')), VISION_TIMEOUT_MS)
      ),
    ]);
  };

  // ── Pass 1: Image → HTML ────────────────────────────────────────────────

  console.log('[templateFromImage] pass 1: generating HTML from image');
  const pass1Start = Date.now();

  const msg = await callWithTimeout({
    model: 'claude-sonnet-4-6',
    max_tokens: 12000,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [imageBlock, { type: 'text', text: userPrompt }],
    }],
  });

  const rawText = getAnthropicMessageText(msg);

  let result;
  try {
    result = extractJsonFromResponse(rawText);
  } catch (e) {
    const retry = await callWithTimeout({
      model: 'claude-sonnet-4-6',
      max_tokens: 12000,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: [imageBlock, { type: 'text', text: userPrompt }] },
        { role: 'assistant', content: msg.content },
        { role: 'user', content: 'Return only the JSON object with "html" and "manifest" keys. No markdown, no code fences.' },
      ],
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

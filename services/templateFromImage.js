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
G) DECORATIVE ELEMENTS: Lines, shapes, simple geometric icons — reproduce as inline SVG.
   ILLUSTRATION RULE: Complex artwork, illustrated characters, detailed graphics, or images with
   many colors and organic shapes CANNOT be recreated as SVG — treat them as image slots instead.
   The original artwork will be cropped and embedded automatically. A safe test: if drawing it in
   SVG would require more than 5-6 paths, use an image slot.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — GENERATE THE HTML TEMPLATE

RULE 1: LAYOUT
   - Root container: <div class="root" style="position:relative; width:Wpx; height:Hpx; overflow:hidden">.
   - Use Flexbox or CSS Grid as primary layout.
   - For LAYERED designs (photo background + text overlay, two panels, etc.) use position:absolute with z-index:
       z-index:0 → background image layer
       z-index:1 → overlay / gradient layer
       z-index:2 → text / content layer
   - Use inline SVG for simple shapes, icons, dividers, and geometric decorative elements.

RULE 2: FONTS
   - Load via <link href="https://fonts.googleapis.com/css2?family=...&display=swap">.
   - Pick the closest Google Font by carefully observing character shapes:
     • Geometric sans-serif (round O, even strokes): Poppins, Nunito Sans, Outfit, DM Sans, Plus Jakarta Sans
     • Humanist sans-serif (slightly calligraphic, varied strokes): Inter, Work Sans, Source Sans Pro
     • Condensed/narrow (tall and tight): Barlow Condensed, Roboto Condensed, Oswald, Bebas Neue (display only)
     • Monospace-influenced / techy (equal-width feel): Space Grotesk, Space Mono, Inconsolata
     • Bold display / impact: Exo 2, Rajdhani, Michroma, Black Ops One
     • Serif / editorial: Playfair Display, Merriweather, Lora, DM Serif Display
     • Script / handwritten: Pacifico, Dancing Script, Caveat
   - Always specify font-weight explicitly. Full range available: 100, 200, 300, 400, 500, 600, 700, 800, 900.
   - For ultra-thin designs use 100 or 200. For light designs use 300. Match what you see exactly.
   - If headline text looks condensed and tall (narrow letters, large size), use a Condensed font family.

RULE 3: COLORS — NON-NEGOTIABLE
   WRONG ✗ (hardcoded hex OR rgba in CSS rule):
     .headline { color: #1a1a2e; }
     <p style="color:#e94560">...</p>
     .overlay { background: rgba(0,0,0,0.5); }

   RIGHT ✓ (CSS custom property on root, var() everywhere else):
     <div class="root" style="--bg:#1a1a2e; --accent:#e94560; --text:#ffffff; --overlay:rgba(0,0,0,0.5)">
     .headline { color: var(--text); }
     .badge { background: var(--accent); }
     .overlay { background: var(--overlay); }

   RULES:
   - ALL color values (#rrggbb, rgba(), hsla()) MUST be in the root container's style="" attribute as CSS custom properties.
   - In EVERY CSS rule and inline style on child elements: use var(--name) ONLY. Never repeat a color literal.
   - One CSS custom property per distinct color. If two elements share a color, they share a var().
   - Add a "color:varname" entry in the manifest for EVERY CSS custom property you define.

RULE 4: TEXT SLOTS — Mark editable text with data-slot="key_name":
   <h1 data-slot="headline">Compelling Headline Here</h1>
   Use snake_case keys. Include realistic placeholder text that matches the image content.

RULE 5: IMAGE SLOTS — ALWAYS use <img> elements, NEVER CSS background-image
   Pattern for a partial/contained image (portrait, logo, etc.):
     <img data-slot="image:photo" src="" alt="Photo" style="width:400px;height:500px;object-fit:cover">

   Pattern for a FULL-BLEED background photo (fills entire template or a full panel):
     <img data-slot="image:photo" src="" alt="Background photo"
          style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:0">
     Then place overlay/text divs with position:absolute and z-index:1+.

   ILLUSTRATION SLOTS: When a region contains complex artwork, illustrated characters, or detailed
   graphics that cannot be cleanly reproduced as SVG, use:
     <img data-slot="image:illustration" src="" alt="Illustration"
          style="position:absolute; top:Ypx; left:Xpx; width:Wpx; height:Hpx; object-fit:contain">
   The original illustration will be cropped from the design and embedded automatically.

   NEVER do this:
     <div style="background-image:url('photo.jpg')">   ← WRONG, slot injection won't work
     background-image: url(...)                         ← WRONG even in CSS rules

   ALWAYS use <img data-slot="image:key"> and style with object-fit:cover or object-fit:contain.
   src MUST be empty string "" — the original photo will be cropped and injected automatically.
   Do NOT put data-slot-container on image parent elements — that is ONLY for repeating slots.

   In the manifest, include the bounding box of the image area in template pixel coordinates:
     "image:photo": { "x": 60, "y": 120, "w": 400, "h": 500 }
   - x, y = top-left corner of the image within the template (in px from top-left of root div)
   - w, h = width and height of the image area (in px)
   - For full-bleed photos: x:0, y:0, w:<templateWidth>, h:<templateHeight>
   Estimate carefully by analyzing where each photo/image appears in the design.

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
   {"slots":{"headline":{"maxLen":80},"subtext":{"maxLen":200},"color:bg":{"default":"#1a1a2e"},"color:accent":{"default":"#e94560"},"color:text":{"default":"#ffffff"},"image:photo":{"x":0,"y":0,"w":1080,"h":1080}},"dimensions":{"width":1080,"height":1080}}
   </script>

   MANIFEST COLOR DEFAULTS — CRITICAL RULE:
   Every "color:varname" default value MUST be the EXACT hex you assigned to --varname on the root element.
   Example: if you wrote style="--bg:#3a3c1a; --accent:#e94560" on the root, the manifest MUST have:
     "color:bg": {"default": "#3a3c1a"},
     "color:accent": {"default": "#e94560"}
   NEVER use "#cccccc" as a default. Copy the exact hex from your CSS var definition.

   - Include ALL color:* slots — one per CSS custom property defined
   - Include ALL image:* slots with bounding box { "x":..., "y":..., "w":..., "h":... }
   - Include ALL text slots with appropriate maxLen

RULE 8: VISUAL FIDELITY
   - Match the image's padding, margins, and spacing precisely.
   - Reproduce font sizes: large headings 36-80px, subheadings 20-28px, body 14-18px.
   - Line-height: 1.1-1.2 for headings, 1.4-1.6 for body.
   - Letter-spacing: tight (-1px to -3px) for large headings if the design uses it; wide (2-8px) for
     uppercase labels if the design uses it.
   - Reproduce rounded corners, shadows, and decorative elements precisely.
   - For gradient backgrounds: use CSS linear-gradient() or radial-gradient() — match direction and all
     color stops exactly. Store each gradient stop color as a separate CSS var.
   - For pattern/texture backgrounds: approximate with CSS gradients or SVG patterns.
   - Reproduce decorative lines, shapes, and simple icons as inline SVG.
   - ARROWS and directional elements: match direction exactly (↗ ↘ ← → ↑ ↓). Do not mirror or flip.

RULE 9: DIMENSIONS — Match the image aspect ratio:
   Square: 1080×1080 | Portrait: 1080×1350 | Landscape: 1200×628

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3 — SELF-CHECK BEFORE OUTPUTTING

Before returning, verify:
□ Root container has class="root" and ALL CSS vars in its style="" attribute
□ Every hex color in the template appears ONLY in the root container's style=""
□ Every CSS rule uses var(--name), never a literal hex value
□ Every image element has data-slot="image:key" (with "image:" prefix) and src=""
□ Every image:* slot in the manifest has x, y, w, h bounding box coordinates
□ Every color:* slot in the manifest has default = the EXACT hex from the root style="" (NOT #cccccc)
□ No data-slot-container on non-repeating elements
□ Complex illustrations use <img data-slot="image:..."> NOT inline SVG paths

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
1. Root <div class="root"> with explicit width/height and overflow:hidden
2. ALL colors as CSS custom properties on root: style="--bg:#hex; --accent:#hex; --text:#hex"
3. Text slots: data-slot="key_name" with snake_case keys
4. Image slots: data-slot="image:key" — if the SVG contains a <image> element with href="data:image/..." (base64 embedded image), PRESERVE that data URI as the src value:
   <img data-slot="image:photo" src="data:image/png;base64,..." alt="Photo">
   This keeps the original image as a default that users can optionally replace.
   If the image href is an external URL, also preserve it as the src value.
   Only use src="" if there is no image data to preserve.
5. Repeating slots: data-slot-container + data-slot-item + data-slot-field
6. Embed manifest as <script type="application/json" id="template-meta"> in <head>
7. Include color:* slots in manifest for each CSS variable — defaults MUST match the exact hex values used

ADVANTAGE: You have the exact SVG source — use the EXACT font-family, EXACT hex colors, EXACT dimensions, and PRESERVE embedded images. Do not approximate anything.

CRITICAL: Return ONLY the raw JSON. No markdown fences, no explanation.`;

// ---------------------------------------------------------------------------
// Pass 2 prompt — refine HTML by comparing original vs rendered
// ---------------------------------------------------------------------------

const REFINE_PROMPT = `You are refining an HTML template to match a design image more precisely.

The image you receive shows a SIDE-BY-SIDE COMPARISON:
  LEFT HALF  = the ORIGINAL DESIGN (the target to match)
  RIGHT HALF = your CURRENT HTML RENDERING (what the code produces now)

Differences that need fixing will be visible as mismatches between left and right.
The current HTML source code is provided below the comparison image.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — SYSTEMATIC DIFF (check EVERY category below)

Go through this checklist and note EVERY difference between LEFT and RIGHT:

A) BACKGROUND: Solid color? Gradient (direction, stops, opacity)? Pattern? Multiple layers?
   - Gradients are commonly missed — check if the LEFT has a gradient the RIGHT renders as flat.
B) TYPOGRAPHY: Font family match? Size? Weight (100/200/300/400/500/600/700/800/900)? Letter-spacing? Line-height? Text-transform (uppercase)?
   - Check EACH text element separately — headings, subheadings, body, labels, captions.
   - Ultra-thin text (weight 100-200) and ultra-bold (900) are commonly missed.
C) COLORS: Compare every text color, background, accent, border, shadow color between LEFT and RIGHT.
D) LAYOUT & SPACING: Padding, margins, gaps between elements. Element alignment (left/center/right). Vertical positioning.
   - Compare element positions at the same location in LEFT vs RIGHT — if an element appears lower/smaller/larger on one side, fix it.
E) DECORATIVE ELEMENTS: Lines, dividers, shapes, badges, icons, dots, circles, underlines, borders.
   - These are the MOST commonly missed elements. Check every edge, corner, and divider in the LEFT.
   - Reproduce as inline SVG with position:absolute if needed.
   - ARROWS and directional icons: match exact direction — do not mirror or flip.
F) BORDERS & SHADOWS: Border-radius values, border widths/colors, box-shadows, text-shadows.
G) IMAGE AREAS: Compare photo size, position, border-radius, and aspect ratio — LEFT vs RIGHT.
H) LAYERING: Overlays, semi-transparent layers, z-index stacking. Does the LEFT have a dark/light overlay over a photo?
I) ILLUSTRATION REGIONS: If the RIGHT shows a broken/incorrect SVG where the LEFT shows
   detailed artwork or characters, REPLACE the SVG entirely with:
   <img data-slot="image:illustration" src="" alt="Illustration" style="position:absolute; ...correct bounds...">
   Do not try to fix SVG path coordinates — replace the entire SVG with an image slot.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — FIX EVERY DIFFERENCE

Apply ALL fixes to the HTML. Common fixes:
- Flat background → CSS linear-gradient() or radial-gradient() with exact direction and stops
- Missing decorative elements → inline SVG with position:absolute
- Wrong font weight → change font-weight and update Google Fonts URL to load that weight
- Missing letter-spacing → add letter-spacing in px or em
- Missing text-transform → add text-transform:uppercase
- Wrong spacing → adjust padding/margin values in px
- Missing borders → add border with correct width, style, color
- Missing shadows → add box-shadow or text-shadow
- Broken SVG illustration → replace with <img data-slot="image:illustration" src="">

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3 — COLOR AUDIT (MANDATORY)

Scan every CSS rule and inline style in the HTML. If you find ANY hardcoded hex value (#rrggbb) or rgba() color outside of the root container's style="" attribute:
1. Add it as a CSS custom property on the root container (--new_var:#hex)
2. Replace the hardcoded value with var(--new_var)
3. Add "color:new_var" to the manifest slots with its EXACT hex value as the default (NOT #cccccc)

INVIOLABLE RULES:
- Keep ALL data-slot, data-slot-container, data-slot-item, data-slot-field attributes exactly as they are
- Keep src="" unchanged on ALL <img data-slot="image:*"> elements
- Keep the <script type="application/json" id="template-meta"> block — you may ADD new entries but do NOT remove existing slots
- Keep all Google Font <link> tags in <head>
- Return the COMPLETE corrected HTML document (not a JSON wrapper — just raw HTML starting with <!DOCTYPE html>)
- No markdown fences, no explanation — only the HTML`;

const VISION_TIMEOUT_MS = 55_000;  // per-AI-call cap; calls rarely exceed 40s

// Pass 2 quality thresholds
const DIFF_SKIP_THRESHOLD = 75;   // skip AI refinement if already this good
const DIFF_STOP_THRESHOLD = 92;   // stop refinement loop once converged
const MAX_REFINEMENT_PASSES = 1;  // 1 pass keeps total pipeline under ~85s

/**
 * Strip AI commentary from a response that should be raw HTML.
 */
function extractHtmlFromResponse(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:html)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

  const doctypeIdx = s.indexOf('<!DOCTYPE');
  const htmlIdx = s.indexOf('<html');
  let startIdx = -1;
  if (doctypeIdx >= 0 && htmlIdx >= 0) startIdx = Math.min(doctypeIdx, htmlIdx);
  else if (doctypeIdx >= 0) startIdx = doctypeIdx;
  else if (htmlIdx >= 0) startIdx = htmlIdx;

  if (startIdx < 0) return null;
  s = s.slice(startIdx);

  const closeIdx = s.lastIndexOf('</html>');
  if (closeIdx >= 0) s = s.slice(0, closeIdx + '</html>'.length);

  return s.trim() || null;
}

/**
 * Extract dominant colors from an image buffer using Sharp pixel sampling.
 * Returns up to 8 hex color strings sorted by frequency.
 */
async function extractDominantColors(buffer) {
  try {
    const { data, info } = await sharp(buffer)
      .resize(80, 80, { fit: 'cover' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const buckets = new Map();
    const THRESHOLD = 30;

    for (let i = 0; i < data.length; i += 3) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      let matched = false;
      for (const [key, bucket] of buckets) {
        const dr = r - bucket.r, dg = g - bucket.g, db = b - bucket.b;
        if (Math.sqrt(dr * dr + dg * dg + db * db) < THRESHOLD) {
          bucket.count++;
          matched = true;
          break;
        }
      }
      if (!matched) {
        const hex = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
        buckets.set(hex, { r, g, b, count: 1 });
      }
    }

    return [...buckets.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8)
      .map(([hex]) => hex);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Zone analysis — detect major layout regions algorithmically
// ---------------------------------------------------------------------------

/**
 * Scan the image both row-by-row (horizontal zones) and column-by-column (vertical zones).
 * High pixel variance = photo/illustration. Low variance = solid color or gradient.
 * Also runs a 30×30 cell grid to find a contained photo bounding box (handles
 * centred portrait photos where per-row scans are diluted by background pixels).
 * Returns { hZones, vZones, photoBox } where photoBox is null or fractional coords (0–1).
 */
async function analyzeImageLayout(buffer) {
  const W = 180, H = 180;
  const PHOTO_V = 500;
  const MIN_ZONE_FRAC = 0.06;
  const GRID = 30; // 30×30 grid → each cell ≈ 36×36px at 1080×1080

  const { data } = await sharp(buffer)
    .resize(W, H, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  function toHex(r, g, b) {
    return '#' + [r, g, b]
      .map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0'))
      .join('');
  }

  // Build per-row stats
  const rowStats = [];
  for (let y = 0; y < H; y++) {
    let sr = 0, sg = 0, sb = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      sr += data[i]; sg += data[i + 1]; sb += data[i + 2];
    }
    const ar = sr / W, ag = sg / W, ab = sb / W;
    let v = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      v += (data[i]-ar)**2 + (data[i+1]-ag)**2 + (data[i+2]-ab)**2;
    }
    rowStats.push({ r: ar, g: ag, b: ab, v: v / W });
  }

  // Build per-column stats
  const colStats = [];
  for (let x = 0; x < W; x++) {
    let sr = 0, sg = 0, sb = 0;
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * 3;
      sr += data[i]; sg += data[i + 1]; sb += data[i + 2];
    }
    const ar = sr / H, ag = sg / H, ab = sb / H;
    let v = 0;
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * 3;
      v += (data[i]-ar)**2 + (data[i+1]-ag)**2 + (data[i+2]-ab)**2;
    }
    colStats.push({ r: ar, g: ag, b: ab, v: v / H });
  }

  // Generic zone detector: takes a stats array (rows or cols), returns zone descriptors
  function detectZones(stats, dim) {
    const MIN_ZONE = Math.ceil(dim * MIN_ZONE_FRAC);

    // Smooth variance with 5-sample window
    const smoothV = stats.map((_, i) => {
      let sum = 0, cnt = 0;
      for (let d = -2; d <= 2; d++) {
        if (i + d >= 0 && i + d < dim) { sum += stats[i + d].v; cnt++; }
      }
      return sum / cnt;
    });

    const types = smoothV.map(v => v > PHOTO_V ? 'photo' : 'solid');

    const raw = [];
    let start = 0;
    for (let i = 1; i <= dim; i++) {
      if (i === dim || types[i] !== types[i - 1]) {
        raw.push({ start, end: i, type: types[i - 1] });
        start = i;
      }
    }

    // Merge thin zones into predecessor
    const merged = [];
    for (const z of raw) {
      if (z.end - z.start < MIN_ZONE && merged.length > 0) {
        merged[merged.length - 1].end = z.end;
      } else {
        merged.push({ ...z });
      }
    }

    return merged.map(z => {
      let sr = 0, sg = 0, sb = 0;
      for (let i = z.start; i < z.end; i++) {
        sr += stats[i].r; sg += stats[i].g; sb += stats[i].b;
      }
      const n = z.end - z.start;
      return {
        start: z.start / dim,
        end:   z.end   / dim,
        type:  z.type,
        color: toHex(sr / n, sg / n, sb / n),
      };
    });
  }

  // ── 2D cell grid: find photo bounding boxes ────────────────────────────────
  // Per-row scans are diluted when a centred photo is surrounded by background
  // (e.g. a portrait card with cream borders). The cell grid measures variance
  // in 30×30 local patches so background cells don't wash out photo cells.
  // To avoid mistaking bold text for a photo we require ≥5 consecutive photo
  // rows AND ≥5 photo columns — text is thin; real photos are chunky.
  const cW = W / GRID, cH = H / GRID;
  const photoCells = []; // { cx, cy }
  const cellVarianceMap = new Map(); // "cy:cx" → per-pixel variance (for gradient detection)

  for (let cy = 0; cy < GRID; cy++) {
    for (let cx = 0; cx < GRID; cx++) {
      const x0 = Math.floor(cx * cW), x1 = Math.floor((cx + 1) * cW);
      const y0 = Math.floor(cy * cH), y1 = Math.floor((cy + 1) * cH);
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 3;
          sr += data[i]; sg += data[i + 1]; sb += data[i + 2];
          cnt++;
        }
      }
      const ar = sr / cnt, ag = sg / cnt, ab = sb / cnt;
      let v = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 3;
          v += (data[i]-ar)**2 + (data[i+1]-ag)**2 + (data[i+2]-ab)**2;
        }
      }
      const cellV = v / cnt;
      cellVarianceMap.set(`${cy}:${cx}`, cellV);
      if (cellV > PHOTO_V) photoCells.push({ cx, cy });
    }
  }

  // Build a set of rows that have ≥5 photo columns in them
  const rowPhotoColCount = Array.from({ length: GRID }, (_, cy) =>
    photoCells.filter(c => c.cy === cy).length
  );
  const rowIsPhoto = rowPhotoColCount.map(count => count >= 5);

  // Find all distinct photo blocks (up to 4) using iterative best-block search.
  // After finding the primary block, its rows are excluded so a second scan can
  // locate non-overlapping secondary photo regions (e.g. two portrait photos).
  const photoBlocks = [];
  const usedRows = new Set();

  for (let attempt = 0; attempt < 4; attempt++) {
    let bestBlock = null, rStart = -1, rLen = 0;

    for (let cy = 0; cy <= GRID; cy++) {
      const rowAvailable = cy < GRID && rowIsPhoto[cy] && !usedRows.has(cy);
      if (rowAvailable) {
        if (rStart < 0) rStart = cy;
        rLen++;
      } else {
        if (rLen >= 5) {
          const blockCells = photoCells.filter(c => c.cy >= rStart && c.cy < rStart + rLen && !usedRows.has(c.cy));
          if (blockCells.length > 0) {
            const minCX = Math.min(...blockCells.map(c => c.cx));
            const maxCX = Math.max(...blockCells.map(c => c.cx));
            const spanX = maxCX - minCX + 1;
            if (spanX >= 5 && (!bestBlock || rLen * spanX > bestBlock.score)) {
              bestBlock = { rStart, rLen, minCX, maxCX, score: rLen * spanX };
            }
          }
        }
        rStart = -1; rLen = 0;
      }
    }

    if (!bestBlock) break;
    photoBlocks.push(bestBlock);
    // Exclude this block's rows (plus a 2-row gap) from subsequent searches
    for (let r = Math.max(0, bestBlock.rStart - 2); r < Math.min(GRID, bestBlock.rStart + bestBlock.rLen + 2); r++) {
      usedRows.add(r);
    }
  }

  // Convert blocks to fractional bounding boxes
  const photoBoxes = photoBlocks.map(best => {
    const coverX = (best.maxCX - best.minCX + 1) / GRID;
    const coverY = best.rLen / GRID;
    return {
      startX: best.minCX / GRID,
      endX:   (best.maxCX + 1) / GRID,
      startY: best.rStart / GRID,
      endY:   (best.rStart + best.rLen) / GRID,
      isFullBleed: coverX >= 0.80 && coverY >= 0.80,
    };
  });

  let photoBox = photoBoxes[0] || null;

  // Gradient detection: a CSS gradient has spatially uniform cell-level variance
  // (each local patch changes gradually). A real photo has wildly varying per-cell
  // variance — some areas are textured, some smooth. The coefficient of variation
  // (std/mean) of photo-cell variances distinguishes them:
  //   low CV  → uniform moderate variance → likely a CSS gradient
  //   high CV → chaotic variance pattern  → likely a real photo
  let isGradient = false;
  if (photoBox?.isFullBleed) {
    const photoVarValues = photoCells.map(c => cellVarianceMap.get(`${c.cy}:${c.cx}`) || 0);
    if (photoVarValues.length >= 10) {
      const meanV = photoVarValues.reduce((s, v) => s + v, 0) / photoVarValues.length;
      const stdV = Math.sqrt(photoVarValues.reduce((s, v) => s + (v - meanV) ** 2, 0) / photoVarValues.length);
      const cv = meanV > 0 ? stdV / meanV : 0;
      if (cv < 0.30) {
        console.log('[templateFromImage] gradient detected (cv=%.2f) — suppressing full-bleed photo hint', cv);
        isGradient = true;
        photoBox = null;
      }
    }
  }

  // ── Embedded solid panel detection ─────────────────────────────────────────
  // Detect a flat-colour card/billboard/sign embedded inside a photo background
  // (e.g. a white billboard in a street scene, a product mockup on a surface).
  //
  // Strategy:
  //  1. Build a boolean solid-grid from the inverse of photoCells.
  //  2. Dilate 2 rounds so that sparse text cells inside a white region get
  //     absorbed (bold text on white = high variance, but it's inside the panel).
  //  3. BFS flood-fill to find connected solid components.
  //  4. A component qualifies as a "panel" if:
  //       • It doesn't touch any canvas edge (it's floating inside the photo).
  //       • Its area ≥ 10% of the grid (meaningful size, not noise).
  //  5. Take the largest qualifying component as the panel bounding box.
  let panelBox = null;

  // Only worth running when the outer context looks like a photo background
  // (photoBox is full-bleed, meaning photo cells dominate the canvas).
  if (photoBox?.isFullBleed) { try {
    const photoKey = new Set(photoCells.map(c => `${c.cy}:${c.cx}`));

    // 2D solid grid
    let solid = Array.from({ length: GRID }, (_, cy) =>
      Array.from({ length: GRID }, (_, cx) => !photoKey.has(`${cy}:${cx}`))
    );

    // Dilate 2 rounds to fill text-cell gaps inside white panels
    for (let round = 0; round < 2; round++) {
      const next = solid.map(r => [...r]);
      for (let cy = 0; cy < GRID; cy++) {
        for (let cx = 0; cx < GRID; cx++) {
          if (!solid[cy][cx]) {
            if (
              (cy > 0       && solid[cy - 1][cx]) ||
              (cy < GRID-1  && solid[cy + 1][cx]) ||
              (cx > 0       && solid[cy][cx - 1]) ||
              (cx < GRID-1  && solid[cy][cx + 1])
            ) next[cy][cx] = true;
          }
        }
      }
      solid = next;
    }

    // BFS flood-fill — find all connected solid components
    const visited = Array.from({ length: GRID }, () => new Uint8Array(GRID));
    const MIN_PANEL_CELLS = Math.ceil(GRID * GRID * 0.10); // ≥10% of grid

    for (let sy = 0; sy < GRID; sy++) {
      for (let sx = 0; sx < GRID; sx++) {
        if (!solid[sy][sx] || visited[sy][sx]) continue;
        const queue = [[sy, sx]];
        visited[sy][sx] = 1;
        const component = [];
        let touchesEdge = false;
        while (queue.length > 0) {
          const [cy, cx] = queue.pop();
          component.push({ cy, cx });
          if (cy === 0 || cy === GRID - 1 || cx === 0 || cx === GRID - 1) touchesEdge = true;
          for (const [ny, nx] of [[cy-1,cx],[cy+1,cx],[cy,cx-1],[cy,cx+1]]) {
            if (ny >= 0 && ny < GRID && nx >= 0 && nx < GRID && solid[ny][nx] && !visited[ny][nx]) {
              visited[ny][nx] = 1;
              queue.push([ny, nx]);
            }
          }
        }
        if (!touchesEdge && component.length >= MIN_PANEL_CELLS) {
          const minCX = Math.min(...component.map(c => c.cx));
          const maxCX = Math.max(...component.map(c => c.cx));
          const minCY = Math.min(...component.map(c => c.cy));
          const maxCY = Math.max(...component.map(c => c.cy));
          if (!panelBox || component.length > panelBox.area) {
            panelBox = {
              startX: minCX / GRID,
              endX:   (maxCX + 1) / GRID,
              startY: minCY / GRID,
              endY:   (maxCY + 1) / GRID,
              area:   component.length,
            };
          }
        }
      }
    }
  } catch (err) {
    console.warn('[templateFromImage] panelBox detection failed (non-fatal): %s', err.message);
  } }

  return {
    hZones:    detectZones(rowStats, H),
    vZones:    detectZones(colStats, W),
    photoBox,
    photoBoxes,
    panelBox,
    isGradient,
  };
}

/**
 * Format zone analysis into a prompt context string.
 *
 * Priority:
 *   1. photoBox.isFullBleed  → full-bleed background hint
 *   2. photoBox (contained)  → exact pixel bounds for the photo element
 *      + solid zone colors from zone analysis as supplemental info
 *   3. Zone splits only       → full horizontal/vertical split output (legacy path)
 */
function buildLayoutContext({ hZones, vZones, photoBox, photoBoxes, panelBox, isGradient }, tplW, tplH) {
  const hasH = hZones && hZones.length >= 2;
  const hasV = vZones && vZones.length >= 2;
  const lines = [];

  // ── 0. Gradient background ────────────────────────────────────────────────
  if (isGradient) {
    return '\n\nLAYOUT ANALYSIS: The background appears to be a CSS gradient (not a photo). Use background: linear-gradient() or radial-gradient() with the exact color stops and direction you observe in the image. Do NOT use an <img> slot for the background.';
  }

  // ── 1. Full-bleed background photo ────────────────────────────────────────
  if (photoBox?.isFullBleed) {
    const bgLines = [
      '\n\nLAYOUT ANALYSIS: FULL-BLEED BACKGROUND PHOTO.',
      `  Background: <img data-slot="image:bg" src="" alt="Background"`,
      `               style="position:absolute;top:0;left:0;width:${tplW}px;height:${tplH}px;object-fit:cover;z-index:0">`,
      `  Manifest: "image:bg": {"x":0,"y":0,"w":${tplW},"h":${tplH}}`,
    ];

    // ── 1a. Embedded card/panel within the photo ───────────────────────────
    // e.g. a billboard sign, product mockup, phone screen, card on a table.
    if (panelBox) {
      const px = Math.round(panelBox.startX * tplW);
      const py = Math.round(panelBox.startY * tplH);
      const pw = Math.round((panelBox.endX - panelBox.startX) * tplW);
      const ph = Math.round((panelBox.endY - panelBox.startY) * tplH);
      bgLines.push('');
      bgLines.push('  EMBEDDED PANEL detected inside the photo background:');
      bgLines.push(`  Position: x=${px}px, y=${py}px, width=${pw}px, height=${ph}px`);
      bgLines.push('  This is a flat-colour card, billboard, sign, or screen floating within the photo.');
      bgLines.push('  Use a <div> with position:absolute at exactly these measured pixel bounds:');
      bgLines.push(`    <div style="position:absolute;left:${px}px;top:${py}px;width:${pw}px;height:${ph}px;`);
      bgLines.push('          background:<panel-color>;z-index:1">');
      bgLines.push('      <!-- all text, logo, and decorative content goes here -->');
      bgLines.push('    </div>');
      bgLines.push('  CRITICAL: Do NOT make the panel larger or smaller — use EXACTLY these pixel values.');
    } else {
      bgLines.push('  Add gradient/colour overlays at z-index:1, text content at z-index:2+.');
      bgLines.push('  NOTE: if you can see this is actually a CSS gradient, use linear-gradient() instead.');
    }

    return bgLines.join('\n');
  }

  // ── 2. Multiple contained photos ──────────────────────────────────────────
  if (photoBoxes && photoBoxes.length >= 2) {
    lines.push('\n\nLAYOUT ANALYSIS (multiple photo regions detected algorithmically — use these exact pixel values, do NOT re-estimate):');
    photoBoxes.forEach((box, idx) => {
      const slotKey = idx === 0 ? 'image:photo' : `image:photo${idx + 1}`;
      const x = Math.round(box.startX * tplW);
      const y = Math.round(box.startY * tplH);
      const w = Math.round((box.endX - box.startX) * tplW);
      const h = Math.round((box.endY - box.startY) * tplH);
      lines.push(`  PHOTO/PORTRAIT REGION ${idx + 1}: x=${x}px, y=${y}px, width=${w}px, height=${h}px`);
      lines.push(`  → <img data-slot="${slotKey}"`);
      lines.push(`         style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;object-fit:cover">`);
      lines.push(`  → Manifest: "${slotKey}": {"x":${x},"y":${y},"w":${w},"h":${h}}`);
    });
    const solidH = hasH ? hZones.filter(z => z.type === 'solid') : [];
    const solidV = hasV ? vZones.filter(z => z.type === 'solid') : [];
    if (solidH.length || solidV.length) {
      lines.push('  Background zone colors:');
      solidH.forEach(z => {
        const y0 = Math.round(z.start * tplH), y1 = Math.round(z.end * tplH);
        lines.push(`    y=${y0}–${y1}px → ${z.color}`);
      });
      solidV.forEach(z => {
        const x0 = Math.round(z.start * tplW), x1 = Math.round(z.end * tplW);
        lines.push(`    x=${x0}–${x1}px → ${z.color}`);
      });
    }
    return lines.join('\n');
  }

  // ── 3. Contained photo: cell-analysis gives exact pixel bounds ─────────────
  // This beats the zone-analysis approach because per-row scans are diluted by
  // background pixels when a portrait/image is surrounded by solid colour.
  if (photoBox) {
    const x = Math.round(photoBox.startX * tplW);
    const y = Math.round(photoBox.startY * tplH);
    const w = Math.round((photoBox.endX - photoBox.startX) * tplW);
    const h = Math.round((photoBox.endY - photoBox.startY) * tplH);
    lines.push('\n\nLAYOUT ANALYSIS (measured algorithmically — use these exact pixel values, do NOT re-estimate):');
    lines.push(`  PHOTO/PORTRAIT/ILLUSTRATION region: x=${x}px, y=${y}px, width=${w}px, height=${h}px`);
    lines.push(`  → <img data-slot="image:photo"`);
    lines.push(`         style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;object-fit:cover">`);
    lines.push(`  → Manifest slot: "image:photo": {"x":${x},"y":${y},"w":${w},"h":${h}}`);

    // Supplement with solid-zone background colors (zone analysis still useful for colors)
    const solidH = hasH ? hZones.filter(z => z.type === 'solid') : [];
    const solidV = hasV ? vZones.filter(z => z.type === 'solid') : [];
    if (solidH.length || solidV.length) {
      lines.push('  Background zone colors:');
      solidH.forEach(z => {
        const y0 = Math.round(z.start * tplH), y1 = Math.round(z.end * tplH);
        lines.push(`    y=${y0}–${y1}px → ${z.color}`);
      });
      solidV.forEach(z => {
        const x0 = Math.round(z.start * tplW), x1 = Math.round(z.end * tplW);
        lines.push(`    x=${x0}–${x1}px → ${z.color}`);
      });
    }
    return lines.join('\n');
  }

  // ── 3. No photoBox: fall back to full zone-split output ───────────────────
  if (!hasH && !hasV) return '';

  lines.push('\n\nLAYOUT ZONES (measured algorithmically — use these exact pixel values, do not re-estimate):');

  if (hasH) {
    lines.push('  TOP-TO-BOTTOM split:');
    hZones.forEach((z, i) => {
      const y0 = Math.round(z.start * tplH), y1 = Math.round(z.end * tplH);
      const pct = Math.round((z.end - z.start) * 100);
      if (z.type === 'photo') {
        lines.push(`    Zone ${i + 1}: y=${y0}–${y1}px (${pct}%) → PHOTO/ILLUSTRATION — use <img data-slot="image:photo" style="height:${y1-y0}px"> NOT SVG`);
        lines.push(`      Manifest: "image:photo": {"x":0,"y":${y0},"w":${tplW},"h":${y1 - y0}}`);
      } else {
        lines.push(`    Zone ${i + 1}: y=${y0}–${y1}px (${pct}%) → SOLID/GRADIENT, dominant color ${z.color}`);
      }
    });
  }

  if (hasV) {
    lines.push('  LEFT-TO-RIGHT split:');
    vZones.forEach((z, i) => {
      const x0 = Math.round(z.start * tplW), x1 = Math.round(z.end * tplW);
      const pct = Math.round((z.end - z.start) * 100);
      if (z.type === 'photo') {
        lines.push(`    Zone ${i + 1}: x=${x0}–${x1}px (${pct}%) → PHOTO/ILLUSTRATION — use <img data-slot="image:photo" style="width:${x1-x0}px"> NOT SVG`);
        lines.push(`      Manifest: "image:photo": {"x":${x0},"y":0,"w":${x1 - x0},"h":${tplH}}`);
      } else {
        lines.push(`    Zone ${i + 1}: x=${x0}–${x1}px (${pct}%) → SOLID/GRADIENT, dominant color ${z.color}`);
      }
    });
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Post-processing: sync manifest color defaults from actual CSS var values
// ---------------------------------------------------------------------------

/**
 * Read all CSS custom property definitions from the generated HTML (both inline
 * style="" on root and <style> block .root rules), then update every color:* entry
 * in the manifest so its default matches the actual hex value used.
 * Also re-embeds the updated manifest JSON into the HTML script tag.
 */
function syncManifestColors(html, manifest) {
  const cssVars = {};

  // 1. Extract from <style> block .root { --var: value; }
  const styleBlock = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (styleBlock) {
    const rootRule = styleBlock[1].match(/(?:\.root|:root)\s*\{([^}]+)\}/);
    if (rootRule) {
      for (const m of rootRule[1].matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*([^;}\n]+)/g)) {
        cssVars[m[1].trim()] = m[2].trim();
      }
    }
  }

  // 2. Extract from inline style="" on root element (handles either attribute order)
  for (const m of html.matchAll(/<div\b[^>]*\bclass="root"[^>]*>/gi)) {
    const styleAttr = m[0].match(/\bstyle="([^"]*)"/);
    if (styleAttr) {
      for (const v of styleAttr[1].matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*([^;}"]+)/g)) {
        cssVars[v[1].trim()] = v[2].trim();
      }
    }
  }

  if (Object.keys(cssVars).length === 0) return html;

  let changed = false;
  for (const [key, slot] of Object.entries(manifest.slots)) {
    if (!key.startsWith('color:')) continue;
    const varName = key.slice(6); // 'color:bg' → 'bg'
    if (!cssVars[varName]) continue;
    const newDefault = cssVars[varName];
    if (typeof slot === 'object' && slot !== null) {
      if (slot.default !== newDefault) { slot.default = newDefault; changed = true; }
    } else {
      manifest.slots[key] = { default: newDefault }; changed = true;
    }
  }

  // Auto-add color:* slots for CSS vars present in the HTML but missing from the
  // manifest — catches new vars introduced by Pass 2 that weren't added to JSON.
  const isColorValue = v => /^#[0-9a-fA-F]{3,8}$/.test(v) || /^rgba?\(/.test(v) || /^hsla?\(/.test(v);
  for (const [varName, value] of Object.entries(cssVars)) {
    const key = `color:${varName}`;
    if (!manifest.slots[key] && isColorValue(value)) {
      manifest.slots[key] = { default: value };
      changed = true;
    }
  }

  if (changed) {
    const newJson = JSON.stringify({ slots: manifest.slots, dimensions: manifest.dimensions });
    html = html.replace(
      /(<script[^>]*type="application\/json"[^>]*id="template-meta"[^>]*>)([\s\S]*?)(<\/script>)/i,
      `$1${newJson}$3`
    );
    console.log('[templateFromImage] synced manifest colors: %s',
      Object.entries(cssVars).map(([k, v]) => `--${k}:${v}`).join(', '));
  }

  return html;
}

// ---------------------------------------------------------------------------
// Pass 2 quality check: pixel-level diff between original and rendered HTML
// ---------------------------------------------------------------------------

/**
 * Compare two image buffers (original design vs Puppeteer screenshot) by computing
 * average pixel-level RGB distance across a 4×4 grid, excluding known image-slot
 * regions (which are intentionally empty until Pass 3).
 *
 * Returns { score (0–100, higher = better match), avgDiff (0–255), badRegions (string[]) }
 */
async function computePixelDiff(origBuf, rendBuf, manifest) {
  const W = 200, H = 200;
  const { width: tplW = 1080, height: tplH = 1080 } = (manifest && manifest.dimensions) || {};

  // Regions to exclude from diff (image slots have src="" so they'll always differ)
  const excludes = Object.entries((manifest && manifest.slots) || {})
    .filter(([k, v]) => k.startsWith('image:') && v && v.x != null)
    .map(([, v]) => ({
      x1: Math.floor(v.x * W / tplW),
      y1: Math.floor(v.y * H / tplH),
      x2: Math.ceil((v.x + v.w) * W / tplW),
      y2: Math.ceil((v.y + v.h) * H / tplH),
    }));

  const [origData, rendData] = await Promise.all([
    sharp(origBuf).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer(),
    sharp(rendBuf).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer(),
  ]);

  const GRID = 8;  // 8×8 = 64 regions at ~135px granularity (was 4×4 at 270px)
  const cellDiff = new Float32Array(GRID * GRID);
  const cellCount = new Int32Array(GRID * GRID);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (excludes.some(e => x >= e.x1 && x < e.x2 && y >= e.y1 && y < e.y2)) continue;
      const i = (y * W + x) * 3;
      const dr = origData[i] - rendData[i];
      const dg = origData[i + 1] - rendData[i + 1];
      const db = origData[i + 2] - rendData[i + 2];
      const diff = Math.sqrt(dr * dr + dg * dg + db * db);
      const ci = Math.min(Math.floor(y / H * GRID), GRID - 1) * GRID +
                 Math.min(Math.floor(x / W * GRID), GRID - 1);
      cellDiff[ci] += diff;
      cellCount[ci]++;
    }
  }

  const totalDiff = cellDiff.reduce((s, d) => s + d, 0);
  const totalPx = cellCount.reduce((s, c) => s + c, 0);
  const avgDiff = totalPx > 0 ? totalDiff / totalPx : 255;

  const ROW_LABELS = ['top', 'upper-A', 'upper-B', 'mid-upper', 'mid-lower', 'lower-A', 'lower-B', 'bottom'];
  const COL_LABELS = ['far-left', 'left-A', 'left-B', 'center-left', 'center-right', 'right-A', 'right-B', 'far-right'];

  const badRegions = Array.from(cellDiff)
    .map((d, i) => ({
      avg: cellCount[i] > 0 ? d / cellCount[i] : 0,
      name: `${ROW_LABELS[Math.floor(i / GRID)]}-${COL_LABELS[i % GRID]}`,
    }))
    .filter(r => r.avg > 30)
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 6)
    .map(r => r.name);

  // score: 100 = perfect, 0 = completely wrong
  const score = Math.max(0, Math.min(100, 100 - avgDiff / 1.5));

  return { score, avgDiff, badRegions };
}

// ---------------------------------------------------------------------------
// Build side-by-side comparison image for Pass 2 visual diff
// ---------------------------------------------------------------------------

/**
 * Stitch the original design and the current render into a single PNG where
 * the original occupies the LEFT half and the render occupies the RIGHT half.
 * This gives the refine model a spatially-aligned comparison rather than two
 * separate images — differences at the same position in both halves are
 * immediately visible without mental context-switching between image blocks.
 */
async function buildCompositeDiff(origBuf, rendBuf, tplW, tplH) {
  const halfW = Math.floor(tplW / 2);
  const [leftBuf, rightBuf] = await Promise.all([
    sharp(origBuf).resize(halfW, tplH, { fit: 'fill' }).png().toBuffer(),
    sharp(rendBuf).resize(halfW, tplH, { fit: 'fill' }).png().toBuffer(),
  ]);
  // 4px dark divider between halves via a slightly wider canvas background
  const totalW = halfW * 2 + 4;
  return sharp({
    create: { width: totalW, height: tplH, channels: 3, background: { r: 40, g: 40, b: 40 } },
  })
    .composite([
      { input: leftBuf,  top: 0, left: 0 },
      { input: rightBuf, top: 0, left: halfW + 4 },
    ])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function generateTemplateFromImage(imageBuffer, options = {}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  // Detect SVG input
  const bufStr = imageBuffer.toString('utf8', 0, Math.min(200, imageBuffer.length));
  const isSvg = options.contentType === 'image/svg+xml' || bufStr.trimStart().startsWith('<svg') || bufStr.trimStart().startsWith('<?xml');

  let imageBlock, mimeType, originalMeta, cropBuffer;

  const SVG_TEXT_MAX_BYTES = 80_000;

  if (isSvg && imageBuffer.length <= SVG_TEXT_MAX_BYTES) {
    console.log('[templateFromImage] SVG text pipeline (%d bytes)', imageBuffer.length);
    mimeType = 'image/svg+xml';
    imageBlock = null;
  } else if (isSvg) {
    console.log('[templateFromImage] SVG too large for text (%d bytes), converting to PNG', imageBuffer.length);
    try {
      const pngBuf = await sharp(imageBuffer).png().toBuffer();
      const meta = await sharp(pngBuf).metadata();
      cropBuffer = pngBuf;
      originalMeta = meta;
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

    originalMeta = meta;
    cropBuffer = imageBuffer;

    mimeType = meta.format === 'png' ? 'image/png'
             : meta.format === 'webp' ? 'image/webp'
             : 'image/jpeg';

    let resizedBuf = imageBuffer;
    if (meta.width > 2048 || meta.height > 2048) {
      resizedBuf = await sharp(imageBuffer).resize(2048, 2048, { fit: 'inside' }).toBuffer();
    }

    imageBlock = {
      type: 'image',
      source: { type: 'base64', media_type: mimeType, data: resizedBuf.toString('base64') },
      cache_control: { type: 'ephemeral' },
    };
  }

  const client = new Anthropic({ apiKey });

  const callWithTimeout = (params) => Promise.race([
    client.messages.create(params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('AI conversion timed out after 120 seconds')), VISION_TIMEOUT_MS)
    ),
  ]);

  // ── Pre-analysis: extract colors + layout zones (raster images only) ────────

  let colorHint = '';
  let layoutContext = '';

  if (!isSvg && cropBuffer) {
    const [colors, layout] = await Promise.all([
      extractDominantColors(imageBuffer),
      analyzeImageLayout(cropBuffer),
    ]);

    if (colors.length) {
      colorHint = `\n\nEXACT COLORS extracted from this design (use these precise hex values as CSS custom properties — do NOT approximate): ${colors.join(', ')}`;
      console.log('[templateFromImage] extracted %d dominant colors: %s', colors.length, colors.join(', '));
    }

    const tplW = originalMeta?.width || 1080;
    const tplH = originalMeta?.height || 1080;
    layoutContext = buildLayoutContext(layout, tplW, tplH);
    if (layoutContext) {
      const hCount = layout.hZones?.length || 0;
      const vCount = layout.vZones?.length || 0;
      console.log('[templateFromImage] detected zones: %d horizontal, %d vertical', hCount, vCount);
    }
  }

  // ── Pass 1: Design → HTML ──────────────────────────────────────────────────

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
    const basePrompt = options.instructions
      ? `Convert this design image into an HTML template. Additional instructions: ${options.instructions}`
      : 'Convert this design image into an HTML template. Reproduce the layout, typography, colors, and structure as closely as possible.';
    const userPrompt = basePrompt + colorHint + layoutContext;
    pass1System = SYSTEM_PROMPT;
    pass1Messages = [{ role: 'user', content: [imageBlock, { type: 'text', text: userPrompt }] }];
  }

  const msg = await callWithTimeout({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
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
      max_tokens: 16000,
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

  // Post-processing: fix slot prefixes and sync manifest keys to HTML
  function applyPostProcessing(h) {
    // Fix <img> tags missing "image:" prefix in data-slot
    h = h.replace(/<img\b([^>]*?)data-slot="(?!image:)([\w]+)"([^>]*?)>/gs, (match, before, key, after) => {
      console.log('[templateFromImage] fixing image slot prefix: %s → image:%s', key, key);
      manifest.slots[`image:${key}`] = manifest.slots[key] || {};
      delete manifest.slots[key];
      let fixed = `<img${before}data-slot="image:${key}"${after}>`;
      fixed = fixed.replace(/src=["'](?!data:)[^"']*["']/g, 'src=""');
      return fixed;
    });

    // Clear non-empty non-data-URI src on image slots
    h = h.replace(/(<img\b[^>]*data-slot="image:[^"]*"[^>]*?)src=["'](?!data:)[^"']*["']/gs, '$1src=""');

    // Normalize data-slot-container (remove value if present)
    h = h.replace(/data-slot-container="[^"]*"/g, 'data-slot-container');

    // Ensure every data-slot in HTML has a manifest entry
    for (const m of h.matchAll(/data-slot="([^"]+)"/g)) {
      const key = m[1];
      if (key === 'data-slot-container' || key === 'data-slot-item') continue;
      if (!manifest.slots[key]) {
        manifest.slots[key] = key.startsWith('image:') ? {} : { maxLen: 200 };
      }
    }
    return h;
  }

  html = applyPostProcessing(html);
  // Deterministic manifest color sync: CSS var values → manifest defaults
  html = syncManifestColors(html, manifest);

  console.log('[templateFromImage] pass 1 done in %dms (%d bytes, %d slots)',
    Date.now() - pass1Start, html.length, Object.keys(manifest.slots).length);

  // ── Pass 2: Quantitative diff → iterative AI refinement ───────────────────

  const shouldRefine = options.refine !== false;

  if (shouldRefine && imageBlock && cropBuffer && originalMeta) {
    const callRenderService = getRenderService();
    const { width = 1080, height = 1080 } = manifest.dimensions;
    const pass2Start = Date.now();

    for (let pass = 0; pass < MAX_REFINEMENT_PASSES; pass++) {
      let renderedPng;
      try {
        renderedPng = await callRenderService(html, width, height);
      } catch (err) {
        console.warn('[templateFromImage] pass 2.%d: render failed (%s), aborting refinement', pass + 1, err.message);
        break;
      }

      // Quantitative diff check — skip or stop if already good enough
      let diffResult = null;
      try {
        diffResult = await computePixelDiff(cropBuffer, renderedPng, manifest);
        console.log('[templateFromImage] pass 2.%d: diff score=%.1f avgDiff=%.1f bad=%s',
          pass + 1, diffResult.score, diffResult.avgDiff, diffResult.badRegions.join(',') || 'none');
      } catch (err) {
        console.warn('[templateFromImage] pass 2.%d: diff failed (%s), proceeding with refinement', pass + 1, err.message);
      }

      if (diffResult && pass === 0 && diffResult.score >= DIFF_SKIP_THRESHOLD) {
        console.log('[templateFromImage] pass 2: skipping refinement (already good — score %.1f)', diffResult.score);
        break;
      }

      if (diffResult && pass > 0 && diffResult.score >= DIFF_STOP_THRESHOLD) {
        console.log('[templateFromImage] pass 2: converged (score %.1f after %d passes)', diffResult.score, pass);
        break;
      }

      // Build side-by-side visual comparison (original LEFT, render RIGHT)
      let compositeBlock;
      try {
        const compositePng = await buildCompositeDiff(cropBuffer, renderedPng, width, height);
        compositeBlock = {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: compositePng.toString('base64') },
          cache_control: { type: 'ephemeral' },
        };
      } catch (err) {
        console.warn('[templateFromImage] pass 2.%d: composite build failed (%s), falling back to separate images', pass + 1, err.message);
      }

      let diffContext = '';
      if (diffResult && diffResult.badRegions.length > 0) {
        diffContext = ` Pay close attention to the ${diffResult.badRegions.join(', ')} region(s) — pixel diff shows the largest mismatch there. Overall match score: ${diffResult.score.toFixed(0)}/100.`;
      }

      // If composite build succeeded, send one spatially-aligned image.
      // Fall back to two separate images if Sharp composite failed.
      const refineContent = compositeBlock
        ? [
            compositeBlock,
            { type: 'text', text: `The image above is a SIDE-BY-SIDE COMPARISON:\n  • LEFT HALF = original design (the target)\n  • RIGHT HALF = your current render\n\nLook at corresponding positions in left vs right to spot every difference.\n\nCurrent HTML:\n\`\`\`html\n${html}\n\`\`\`\n\nFix every visible difference.${diffContext} Return the complete corrected HTML document.` },
          ]
        : [
            { type: 'text', text: 'Image 1 — Original design:' },
            imageBlock,
            { type: 'text', text: 'Image 2 — Current HTML rendering:' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: renderedPng.toString('base64') } },
            { type: 'text', text: `Current HTML:\n\`\`\`html\n${html}\n\`\`\`\n\nFix every difference between Image 1 and Image 2.${diffContext} Return the complete corrected HTML document.` },
          ];

      const refineMsg = await callWithTimeout({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        system: REFINE_PROMPT,
        messages: [{ role: 'user', content: refineContent }],
      });

      const refinedHtml = extractHtmlFromResponse(getAnthropicMessageText(refineMsg));
      if (refinedHtml) {
        html = applyPostProcessing(refinedHtml);
        html = syncManifestColors(html, manifest);
        console.log('[templateFromImage] pass 2.%d refinement applied (%d bytes, %dms elapsed)',
          pass + 1, html.length, Date.now() - pass2Start);
      } else {
        console.warn('[templateFromImage] pass 2.%d: refinement returned no valid HTML', pass + 1);
        break;
      }
    }
  }

  // ── Pass 3: Crop original photos and embed as default images ──────────────

  if (!useSvgTextPipeline && cropBuffer && originalMeta) {
    try {
      html = await injectCroppedImages(html, manifest, cropBuffer, originalMeta);
    } catch (err) {
      console.warn('[templateFromImage] image injection failed:', err.message);
    }
  }

  return { html, manifest };
}

// ---------------------------------------------------------------------------
// Crop image regions from the original design and inject as default src values.
// ---------------------------------------------------------------------------

async function injectCroppedImages(html, manifest, cropBuffer, originalMeta) {
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
      const cropped = await sharp(cropBuffer)
        .extract({ left, top, width, height })
        .resize({ width: Math.min(Math.round(cfg.w), 600), height: Math.min(Math.round(cfg.h), 600), fit: 'inside' })
        .jpeg({ quality: 80 })
        .toBuffer();

      const dataUri = `data:image/jpeg;base64,${cropped.toString('base64')}`;
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const prevLen = html.length;

      const srcEmpty = `src=(?:""|'')`;

      html = html.replace(
        new RegExp(`(<img\\b[^>]*?data-slot="${escapedKey}"[^>]*?)${srcEmpty}`, 'gs'),
        `$1src="${dataUri}"`
      );
      html = html.replace(
        new RegExp(`(<img\\b[^>]*?)${srcEmpty}([^>]*?data-slot="${escapedKey}"[^>]*?>)`, 'gs'),
        `$1src="${dataUri}"$2`
      );
      if (html.length === prevLen) {
        html = html.replace(
          new RegExp(`(<img\\b[^>]*?data-slot="${escapedKey}"[^>]*?)(\\s*/?>)`, 'gs'),
          `$1 src="${dataUri}"$2`
        );
      }

      if (html.length !== prevLen) {
        console.log('[templateFromImage] injected default image for %s (%dx%d, %d bytes JPEG)',
          key, width, height, cropped.length);
      } else {
        console.warn('[templateFromImage] could not inject src for img[data-slot="%s"] — element not found', key);
      }
    } catch (err) {
      console.warn('[templateFromImage] crop failed for %s:', key, err.message);
    }
  }

  return html;
}

module.exports = { generateTemplateFromImage };

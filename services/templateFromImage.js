'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const { extractJsonFromResponse, getAnthropicMessageText } = require('./voiceFingerprint');
const sharp = require('sharp');

const SYSTEM_PROMPT = `You are an expert HTML/CSS developer who converts design images into Puppeteer-compatible HTML templates for a LinkedIn visual content tool called ScoutHook.

OUTPUT FORMAT:
Return a JSON object with exactly two keys:
{
  "html": "<!DOCTYPE html>...",
  "manifest": { "slots": {...}, "dimensions": {...} }
}

TEMPLATE REQUIREMENTS:

1. LAYOUT — Use a single root container <div> with explicit width and height in px. Use CSS Flexbox or Grid for layout. NEVER use position:absolute. Use overflow:hidden on root.

2. FONTS — Load Google Fonts via <link> in <head>. Recommended: Poppins (headings, weight 600-800), Inter (body, weight 400-500). Always specify font-weight explicitly.

3. COLORS — Define all colors as CSS custom properties on the root container:
   style="--bg:#1a1a2e; --accent:#e94560; --text:#ffffff; --text-muted:rgba(255,255,255,0.7)"
   Use var(--bg), var(--accent), etc. in all child elements. This allows user color customization.

4. EDITABLE SLOTS — Mark user-editable text elements with data-slot="key_name":
   <h1 data-slot="headline">Headline Text</h1>
   <p data-slot="subtitle">Supporting text</p>
   Use snake_case for slot keys. Include realistic placeholder text matching the image.

5. IMAGE SLOTS — For user-uploadable images:
   <img data-slot="image:photo" src="" alt="Photo" style="width:100%;height:200px;object-fit:cover;border-radius:12px">
   Key must start with "image:".

6. REPEATING SLOTS — For lists, steps, or repeated items:
   <div data-slot="items" data-slot-container>
     <div data-slot-item>
       <h3 data-slot-field="title">Step 1</h3>
       <p data-slot-field="body">Description</p>
     </div>
   </div>
   Include 2-3 example items with realistic placeholder content.

7. MANIFEST — Include in the HTML as:
   <script type="application/json" id="template-meta">
   {"slots":{...},"dimensions":{"width":W,"height":H}}
   </script>

   Slot definitions:
   - Text: { "maxLen": 80 } (set appropriate limits)
   - Color: { "default": "#hexcolor" } (key starts with "color:")
   - Image: {} (key starts with "image:")
   - Repeating: { "type": "repeating", "fields": ["title","body"], "min": 2, "max": 6 }

8. VISUAL QUALITY:
   - Generous padding (40-60px outer, 20-30px between sections)
   - Clear font hierarchy: heading 36-48px, subheading 20-28px, body 14-18px
   - Line-height: 1.15 for headings, 1.5 for body
   - Letter-spacing: -1px to -2px for large headings
   - Rounded corners on images and cards (8-16px)
   - Subtle shadows for depth where appropriate
   - Background patterns or gradients for visual interest
   - Ensure high contrast between text and background

9. DIMENSIONS — Common LinkedIn sizes:
   - Square: 1080x1080 (default)
   - Portrait: 1080x1350
   - Landscape: 1200x628
   Choose the size that best matches the uploaded image's aspect ratio.

CRITICAL: Return ONLY the JSON object. No markdown, no code fences, no explanation.`;

async function generateTemplateFromImage(imageBuffer, options = {}) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const meta = await sharp(imageBuffer).metadata();
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

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: userPrompt },
      ],
    }],
  });

  const rawText = getAnthropicMessageText(msg);

  let result;
  try {
    result = extractJsonFromResponse(rawText);
  } catch (e) {
    const retry = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text', text: userPrompt },
          ],
        },
        { role: 'assistant', content: msg.content },
        { role: 'user', content: 'Return only the JSON object with "html" and "manifest" keys. No markdown, no code fences.' },
      ],
    });
    result = extractJsonFromResponse(getAnthropicMessageText(retry));
  }

  if (!result.html || typeof result.html !== 'string') {
    throw new Error('Claude did not return valid HTML');
  }

  const manifest = result.manifest || { slots: {}, dimensions: { width: 1080, height: 1080 } };
  if (!manifest.slots) manifest.slots = {};
  if (!manifest.dimensions) manifest.dimensions = { width: 1080, height: 1080 };

  return { html: result.html, manifest };
}

module.exports = { generateTemplateFromImage };

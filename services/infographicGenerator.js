'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const { extractJsonFromResponse, getAnthropicMessageText } = require('./voiceFingerprint');
const storage = require('./storage');
const { renderLayout, resolveFonts, buildTheme, buildLayout, renderToBuffer, W_SQUARE, H_SQUARE } = require('./satoriRenderer');
const { CURATED_ICONS } = require('./iconLibrary');

const LAYOUT_TYPES = ['card-grid', 'numbered-list', 'metric', 'quote', 'two-column'];
const THEME_VARIANTS = ['dark', 'light', 'accent'];

const EXTRACT_PROMPT = `Analyze this LinkedIn post and create an infographic layout. Return ONLY valid JSON matching one of these formats.

Available icons (pick one per item from this list): ${CURATED_ICONS.join(', ')}

FORMAT 1 — card-grid (best for posts listing tips, tools, strategies, or features):
{
  "type": "card-grid",
  "columns": 2,
  "tag": "SHORT CATEGORY (2-3 words, uppercase feel)",
  "title": "Compelling headline (max 10 words)",
  "subtitle": "One-line teaser (optional)",
  "items": [
    { "title": "Card title (2-4 words)", "body": "1-2 sentences explaining this point.", "icon": "icon-name" },
    ...
  ]
}

FORMAT 2 — numbered-list (best for step-by-step posts, habits, mistakes, rules):
{
  "type": "numbered-list",
  "tag": "SHORT CATEGORY",
  "title": "Compelling headline (max 10 words)",
  "items": [
    { "title": "Step name (2-5 words)", "body": "1 sentence explanation.", "icon": "icon-name" },
    ...
  ]
}

FORMAT 3 — metric (best for posts about results, revenue, growth numbers):
{
  "type": "metric",
  "title": "Context headline (max 6 words)",
  "items": [{ "value": "THE BIG NUMBER", "label": "What it means (one line)", "context": "WHO or WHAT (2-4 words)" }]
}

FORMAT 4 — quote (best for testimonials, powerful statements, client feedback):
{
  "type": "quote",
  "title": "Context label (max 4 words)",
  "items": [{ "quote": "The exact quote (1-3 sentences)", "attribution": "Name, Role at Company" }]
}

FORMAT 5 — two-column (best for comparison, before/after, input/output, problem/solution):
{
  "type": "two-column",
  "tag": "SHORT CATEGORY",
  "title": "Compelling headline (max 10 words)",
  "items": [
    { "title": "Left item 1 (2-5 words)", "body": "1 sentence.", "icon": "icon-name" },
    { "title": "Right item 1 (2-5 words)", "body": "1 sentence.", "icon": "icon-name" },
    { "title": "Left item 2", "body": "...", "icon": "icon-name" },
    { "title": "Right item 2", "body": "...", "icon": "icon-name" },
    ...
  ]
}

Rules:
- Pick the ONE format that best matches the post's content structure
- card-grid items: 4-8 items. Each body: 1-2 short sentences max
- numbered-list items: 3-10 items. Each body: 1 sentence
- two-column items: 4-8 items (always even number, alternating left/right)
- metric value: use plain ASCII characters only. No currency symbols, no arrows. Example: "3L to 18L" not "₹3L → ₹18L"
- All text must be concise — this is a visual, not an article
- Headlines should be punchy and specific, not generic
- Tag should be a short category like "LINKEDIN GROWTH" or "COACHING" or "SALES"
- Do NOT wrap in markdown code fences. Return raw JSON only.

POST:
`;

async function extractInfographicContent(post) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const client = new Anthropic({ apiKey });
  const userPrompt = EXTRACT_PROMPT + post.content;

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2000,
    messages: [{ role: 'user', content: userPrompt }],
  });

  let layout;
  const rawText = getAnthropicMessageText(msg);
  try {
    layout = extractJsonFromResponse(rawText);
  } catch (e) {
    const retry = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 2000,
      messages: [
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: msg.content },
        { role: 'user', content: 'Return only valid JSON, no other text.' },
      ],
    });
    layout = extractJsonFromResponse(getAnthropicMessageText(retry));
  }

  return validateLayout(layout);
}

function validateLayout(layout) {
  if (!layout || typeof layout !== 'object') {
    throw new Error('Invalid layout: not an object');
  }

  if (!LAYOUT_TYPES.includes(layout.type)) {
    layout.type = 'card-grid';
  }

  if (!Array.isArray(layout.items)) {
    layout.items = [];
  }

  if (layout.type === 'card-grid') {
    layout.columns = [2, 3, 4].includes(layout.columns) ? layout.columns : 2;
    layout.items = layout.items.slice(0, 12).map(item => ({
      title: String(item.title || '').slice(0, 60),
      body: String(item.body || '').slice(0, 200),
      icon: CURATED_ICONS.includes(item.icon) ? item.icon : undefined,
    }));
    if (layout.items.length < 2) {
      throw new Error('card-grid needs at least 2 items');
    }
  }

  if (layout.type === 'numbered-list') {
    layout.items = layout.items.slice(0, 12).map(item => ({
      title: String(item.title || '').slice(0, 60),
      body: String(item.body || '').slice(0, 200),
      icon: CURATED_ICONS.includes(item.icon) ? item.icon : undefined,
    }));
    if (layout.items.length < 2) {
      throw new Error('numbered-list needs at least 2 items');
    }
  }

  if (layout.type === 'metric') {
    const item = layout.items[0] || {};
    layout.items = [{
      value: String(item.value || '---').slice(0, 30),
      label: String(item.label || '').slice(0, 80),
      context: item.context ? String(item.context).slice(0, 40) : undefined,
    }];
  }

  if (layout.type === 'quote') {
    const item = layout.items[0] || {};
    layout.items = [{
      quote: String(item.quote || '').slice(0, 300),
      attribution: item.attribution ? String(item.attribution).slice(0, 60) : undefined,
    }];
  }

  if (layout.type === 'two-column') {
    layout.items = layout.items.slice(0, 12).map(item => ({
      title: String(item.title || '').slice(0, 60),
      body: String(item.body || '').slice(0, 200),
      icon: CURATED_ICONS.includes(item.icon) ? item.icon : undefined,
    }));
    if (layout.items.length % 2 !== 0) layout.items.pop();
    if (layout.items.length < 2) {
      throw new Error('two-column needs at least 2 items');
    }
  }

  layout.title = layout.title ? String(layout.title).slice(0, 80) : undefined;
  layout.subtitle = layout.subtitle ? String(layout.subtitle).slice(0, 100) : undefined;
  layout.tag = layout.tag ? String(layout.tag).slice(0, 30) : undefined;

  return layout;
}

async function renderInfographic(post, brand = {}, content, ctx = {}, variant = 'dark') {
  const { userId, tenantId } = ctx;

  if (!THEME_VARIANTS.includes(variant)) variant = 'dark';

  const pngBuffer = await renderLayout(brand, content, variant);

  const filename = `infographic_${post.id}_${Date.now()}.png`;
  await storage.upload(pngBuffer, { tenantId, userId, type: 'generated', filename, mimeType: 'image/png' });

  return { png_url: `/files/${filename}`, layout: content };
}

async function generateInfographic(post, brand = {}, ctx = {}, variant = 'dark') {
  const content = await extractInfographicContent(post);
  return renderInfographic(post, brand, content, ctx, variant);
}

module.exports = {
  extractInfographicContent,
  renderInfographic,
  generateInfographic,
  validateLayout,
  LAYOUT_TYPES,
  THEME_VARIANTS,
};

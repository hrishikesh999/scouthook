'use strict';

const sharp = require('sharp');
const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const storage = require('./storage');
const { getAnthropicMessageText } = require('./voiceFingerprint');

// Brand tokens
const BG = '#0F1A3C';
const ACCENT = '#0D7A5F';
const TEXT = '#F0F4FF';
const TEXT_MUTED = '#8A9CC0';
const W = 1080;
const H = 1080;

async function extractQuoteCardContent(post) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');
  const client = new Anthropic({ apiKey });
  const extractMsg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Extract the single most impactful, memorable sentence from this post. Return only that sentence — nothing else, no punctuation changes, no explanation.\n\n${post.content}`,
    }],
  });
  return { quote: getAnthropicMessageText(extractMsg) || post.content.split('\n')[0] };
}

async function renderQuoteCard(post, brand = {}, content, ctx = {}) {
  const { userId, tenantId } = ctx;
  const svg = buildQuoteCardSvg(content.quote, brand);
  const filename = `quote_${post.id}_${Date.now()}.png`;
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  await storage.upload(pngBuffer, { tenantId, userId, type: 'generated', filename, mimeType: 'image/png' });
  return { svg, png_url: `/files/${filename}` };
}

async function generateQuoteCard(post, brand = {}, ctx = {}) {
  const content = await extractQuoteCardContent(post);
  return renderQuoteCard(post, brand, content, ctx);
}

function buildQuoteCardSvg(quote, brand = {}) {
  const bg     = brand.bg     || BG;
  const accent = brand.accent || ACCENT;
  const text   = brand.text   || TEXT;

  // Accent bar right edge is at x=80. Keep text ≥24px clear → clip from x=104.
  // Symmetric right clip: 1080-104=976. At 50px font ~26.5px/char, 32 chars ≈ 848px
  // centred at 540 → extends to x=116 left, x=964 right — well inside both clip edges.
  const TEXT_LEFT_CLIP = 104;
  const TEXT_RIGHT_CLIP = W - TEXT_LEFT_CLIP;
  const lines = wrapText(quote, 32);
  const lineHeight = 72;
  const blockHeight = lines.length * lineHeight;
  const startY = (H - blockHeight) / 2;

  const linesXml = lines.map((line, i) =>
    `<text x="540" y="${startY + i * lineHeight}" font-family="system-ui, -apple-system, 'Helvetica Neue', sans-serif" font-size="50" font-weight="500" letter-spacing="-0.3" fill="${text}" text-anchor="middle" dominant-baseline="hanging" clip-path="url(#quoteTextClip)">${escapeXml(line)}</text>`
  ).join('\n  ');

  // Brand mark: logo image > brand name text > "Scouthook" fallback
  let brandXml;
  if (brand.logo) {
    brandXml = `<image href="${brand.logo}" x="440" y="${H - 96}" width="200" height="56" preserveAspectRatio="xMidYMid meet"/>`;
  } else {
    const brandLabel = escapeXml(brand.name || 'Scouthook');
    brandXml = `<text x="540" y="${H - 64}" font-family="system-ui, -apple-system, 'Helvetica Neue', sans-serif" font-size="28" font-weight="600" fill="${TEXT_MUTED}" text-anchor="middle">${brandLabel}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs><clipPath id="quoteTextClip"><rect x="${TEXT_LEFT_CLIP}" y="0" width="${TEXT_RIGHT_CLIP - TEXT_LEFT_CLIP}" height="${H}"/></clipPath></defs>
  <rect width="${W}" height="${H}" fill="${bg}"/>
  <rect x="72" y="${startY - 40}" width="8" height="${blockHeight + 80}" fill="${accent}" rx="4"/>
  ${linesXml}
  ${brandXml}
</svg>`;
}

/**
 * Wrap text into lines of at most maxChars characters, breaking on word boundaries.
 */
function wrapText(text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length <= maxChars) {
      current = (current + ' ' + word).trim();
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { generateQuoteCard, extractQuoteCardContent, renderQuoteCard };

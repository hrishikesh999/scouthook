'use strict';

const path = require('path');
const sharp = require('sharp');
const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');

const GENERATED_DIR = path.join(__dirname, '..', 'generated');

const TEXT_MUTED = '#8A9CC0';
const W = 1080;
const H = 1080;

const AVATAR = 88;
const AVATAR_X = 72;
const TEXT_LEFT = 184;
const BODY_X = 80;
const FONT_SIZE = 40;
const LINE_HEIGHT = 58;
const MAX_CHARS = 48;
const MAX_LINES = 4;

/** Minimum padding from top edge (increased for breathing room). */
const TOP_INSET_MIN = 140;
/** Space reserved at bottom for brand mark + padding. */
const FOOTER_RESERVE = 150;
/** Gap between header cluster and quote body. */
const GAP_HEADER_TO_BODY = 52;
/** Vertical offsets within the content block (relative to block top = avatar top). */
const NAME_Y_OFFSET = 36;
const BRAND_Y_OFFSET = 80;

const BRAND_LOGO_Y = H - 100;
const BRAND_TEXT_Y = H - 72;

/**
 * Vertically center header + quote in the canvas minus top minimum and footer zone
 * so short quotes do not leave a huge empty band in the lower half.
 */
function computeLayoutYs(lines, hasBrandHeader) {
  const headerEndOffset = hasBrandHeader ? BRAND_Y_OFFSET + 28 : NAME_Y_OFFSET + 28;
  const bodyStartOffset = headerEndOffset + GAP_HEADER_TO_BODY;
  const n = Math.max(1, lines.length);
  const quoteTextBottomOffset =
    bodyStartOffset + (n - 1) * LINE_HEIGHT + FONT_SIZE + 16;
  const blockHeight = Math.max(AVATAR, quoteTextBottomOffset);

  const available = H - TOP_INSET_MIN - FOOTER_RESERVE;
  const blockTop = TOP_INSET_MIN + Math.max(0, (available - blockHeight) / 2);

  const avatarY = blockTop;
  const nameY = blockTop + NAME_Y_OFFSET;
  const brandY = blockTop + BRAND_Y_OFFSET;
  const bodyStartY = blockTop + bodyStartOffset;
  const fadeTop = Math.min(
    H - 100,
    bodyStartY + (n - 1) * LINE_HEIGHT + FONT_SIZE + 32
  );

  return { avatarY, nameY, brandY, bodyStartY, fadeTop };
}

/**
 * LinkedIn-style branded quote: avatar + name + brand + excerpt with bottom fade + brand mark.
 *
 * @param {object} post — { id, content }
 * @param {object} brand — { bg, text, name?, logo? }
 * @param {object} linkedin — { photoDataUri: string, name: string }
 * @returns {Promise<{ svg: string, png_url: string }>}
 */
async function generateBrandedQuote(post, brand = {}, linkedin = {}) {
  const bg = brand.bg || '#0F1A3C';
  const text = brand.text || '#F0F4FF';

  const quoteText = await extractBrandedQuoteText(post.content || '');
  const previewLines = linesFromQuote(quoteText, MAX_LINES, MAX_CHARS);
  const svg = buildBrandedQuoteSvg(previewLines, brand, linkedin, bg, text);

  const filename = `branded_quote_${post.id}_${Date.now()}.png`;
  const outputPath = path.join(GENERATED_DIR, filename);
  await sharp(Buffer.from(svg)).png().toFile(outputPath);

  return { svg, png_url: `/files/${filename}` };
}

/**
 * One or two complete sentences — strongest idea from the full post (Haiku).
 */
async function extractBrandedQuoteText(content) {
  const apiKey = getSetting('anthropic_api_key');
  if (!apiKey) return fallbackBrandedQuoteText(content);

  const client = new Anthropic({ apiKey });
  try {
    const extractMsg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 250,
      messages: [{
        role: 'user',
        content: `Read the entire LinkedIn post below. Pick the single most powerful, self-contained idea—the passage that would work as a standalone social quote graphic.

Rules:
- Output exactly 1 or 2 complete sentences only (grammatical sentences ending with . ! or ?). No fragments, no bullet points, no quotation marks around the output.
- Choose the strongest takeaway from anywhere in the post, not necessarily the opening.
- Keep the total under 160 characters — it must fit in four lines of ~40 characters each on a square image.
- Return only that text—nothing else.

POST:
${content}`,
      }],
    });
    const raw = extractMsg.content[0]?.text?.trim() || '';
    if (raw) return sanitizeExtractedQuote(raw);
  } catch (err) {
    console.warn('[brandedQuote] extract failed:', err.message);
  }
  return fallbackBrandedQuoteText(content);
}

function sanitizeExtractedQuote(s) {
  return s
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

/**
 * First complete sentence(s) from the post when AI is unavailable.
 */
function fallbackBrandedQuoteText(content) {
  const text = (content || '').trim();
  if (!text) return '';

  const firstPara = text.split(/\n+/).map(p => p.trim()).find(Boolean) || text;
  const sentences = firstPara.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length) {
    let out = sentences[0].trim();
    if (sentences[1] && `${out} ${sentences[1].trim()}`.length <= 160) {
      out = `${out} ${sentences[1].trim()}`;
    }
    return out;
  }
  return trimToCompleteSentence(firstPara.slice(0, 160));
}

function trimToCompleteSentence(text) {
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === '.' || text[i] === '!' || text[i] === '?') {
      return text.slice(0, i + 1).trim();
    }
  }
  return text;
}

function linesFromQuote(text, maxLines, maxChars) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const wrapped = wrapText(normalized, maxChars);

  if (wrapped.length <= maxLines) {
    return wrapped.length ? wrapped : [''];
  }

  // Text overflows — trim the candidate to the last complete sentence, then re-wrap
  const candidate = wrapped.slice(0, maxLines).join(' ');
  const trimmed = trimToCompleteSentence(candidate);
  const result = wrapText(trimmed, maxChars);
  return result.length ? result.slice(0, maxLines) : [''];
}

function wrapText(text, maxChars) {
  const words = text.split(/\s+/);
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

function buildBrandedQuoteSvg(lines, brand, linkedin, bg, text) {
  const memberName = escapeXml(linkedin.name || '');
  const brandLabel = brand.name ? escapeXml(brand.name) : '';

  const { avatarY, nameY, brandY, bodyStartY, fadeTop } = computeLayoutYs(lines, !!brandLabel);

  const cx = AVATAR_X + AVATAR / 2;
  const cy = avatarY + AVATAR / 2;

  const avatarXml = linkedin.photoDataUri
    ? `<defs>
  <clipPath id="avatarClip"><circle cx="${cx}" cy="${cy}" r="${AVATAR / 2}"/></clipPath>
</defs>
<image href="${linkedin.photoDataUri}" x="${AVATAR_X}" y="${avatarY}" width="${AVATAR}" height="${AVATAR}" clip-path="url(#avatarClip)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${AVATAR / 2}" fill="${TEXT_MUTED}" opacity="0.35"/>`;

  const nameXml = `<text x="${TEXT_LEFT}" y="${nameY}" font-family="system-ui,-apple-system,'Helvetica Neue',sans-serif" font-size="32" font-weight="600" fill="${text}" dominant-baseline="middle">${memberName}</text>`;

  const brandHeaderXml = brandLabel
    ? `<text x="${TEXT_LEFT}" y="${brandY}" font-family="system-ui,-apple-system,'Helvetica Neue',sans-serif" font-size="24" font-weight="500" fill="${TEXT_MUTED}" dominant-baseline="middle">${brandLabel}</text>`
    : '';

  const bodyXml = lines.map((line, i) =>
    `<text x="${BODY_X}" y="${bodyStartY + i * LINE_HEIGHT}" font-family="system-ui,-apple-system,'Helvetica Neue',sans-serif" font-size="${FONT_SIZE}" font-weight="500" letter-spacing="-0.2" fill="${text}" dominant-baseline="hanging">${escapeXml(line)}</text>`
  ).join('\n  ');

  const fadeXml = `<defs>
  <linearGradient id="brandedFade" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${bg}" stop-opacity="0"/>
    <stop offset="100%" stop-color="${bg}" stop-opacity="1"/>
  </linearGradient>
</defs>
<rect x="0" y="${fadeTop}" width="${W}" height="${H - fadeTop}" fill="url(#brandedFade)"/>`;

  let brandMarkXml;
  if (brand.logo) {
    brandMarkXml = `<image href="${brand.logo}" x="440" y="${BRAND_LOGO_Y}" width="200" height="56" preserveAspectRatio="xMidYMid meet"/>`;
  } else {
    const mark = escapeXml(brand.name || 'Scouthook');
    brandMarkXml = `<text x="540" y="${BRAND_TEXT_Y}" font-family="system-ui,-apple-system,'Helvetica Neue',sans-serif" font-size="28" font-weight="600" fill="${TEXT_MUTED}" text-anchor="middle">${mark}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  ${avatarXml}
  ${nameXml}
  ${brandHeaderXml}
  ${bodyXml}
  ${fadeXml}
  ${brandMarkXml}
</svg>`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { generateBrandedQuote };

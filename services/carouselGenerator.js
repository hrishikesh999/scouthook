'use strict';

const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const archiver = require('archiver');
const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const { extractJsonFromResponse, getAnthropicMessageText } = require('./voiceFingerprint');
const storage = require('./storage');

// Brand tokens
const BG = '#0F1A3C';
const ACCENT = '#0D7A5F';
const TEXT = '#F0F4FF';
const TEXT_MUTED = '#8A9CC0';
const BG_CARD = '#162040';
const W = 1080;
const H = 1080;

async function extractCarouselContent(post) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const client = new Anthropic({ apiKey });

  const carouselUserPrompt = `Break this LinkedIn post into exactly 6 to 8 slides for a carousel. Return ONLY valid JSON:
{
  "slides": [
    { "type": "title", "headline": "short punchy title (max 8 words)", "body": "" },
    { "type": "content", "headline": "short headline (max 8 words)", "body": "2-3 sentences" },
    ...
    { "type": "closing", "headline": "closing thought (max 8 words)", "body": "1-2 sentences with CTA or takeaway" }
  ]
}

Rules:
- First slide: type "title", compelling headline, no body
- Last slide: type "closing", brief takeaway or CTA
- Middle slides: type "content", each covers one clear idea from the post
- Total slides: minimum 6, maximum 8
- Each body: 2-3 short sentences max. Never paste a full paragraph.
- Headlines: punchy, specific — not generic labels

POST:
${post.content}`;

  const slideMsg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1500,
    messages: [{ role: 'user', content: carouselUserPrompt }],
  });

  let slidesData;
  const rawText = getAnthropicMessageText(slideMsg);
  try {
    slidesData = extractJsonFromResponse(rawText);
  } catch (e) {
    const retry = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
      messages: [
        { role: 'user', content: carouselUserPrompt },
        { role: 'assistant', content: slideMsg.content },
        { role: 'user', content: 'Return only valid JSON, no other text.' },
      ],
    });
    slidesData = extractJsonFromResponse(getAnthropicMessageText(retry));
  }

  const slides = slidesData.slides;
  if (!slides || slides.length < 6 || slides.length > 8) {
    throw new Error(`Expected 6-8 slides, got ${slides?.length}`);
  }

  return { slides };
}

async function renderCarousel(post, brand = {}, content, ctx = {}) {
  const { userId, tenantId } = ctx;
  const { slides } = content;

  const timestamp = Date.now();
  const pngBuffers = [];
  const slideResults = [];

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const svg = buildSlideSvg(slide, i + 1, slides.length, brand);
    const filename = `carousel_${post.id}_${timestamp}_slide${i + 1}.png`;
    const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
    await storage.upload(pngBuffer, { tenantId, userId, type: 'generated', filename, mimeType: 'image/png' });
    pngBuffers.push({ buffer: pngBuffer, filename });
    slideResults.push({ svg, png_url: `/files/${filename}` });
  }

  const zipFilename = `carousel_${post.id}_${timestamp}.zip`;
  const zipBuffer = await buildZipBuffer(pngBuffers);
  await storage.upload(zipBuffer, { tenantId, userId, type: 'generated', filename: zipFilename, mimeType: 'application/zip' });

  const pdfFilename = `carousel_${post.id}_${timestamp}.pdf`;
  const pdfBytes = await buildCarouselPdfFromBuffers(pngBuffers.map(p => p.buffer));
  await storage.upload(Buffer.from(pdfBytes), { tenantId, userId, type: 'generated', filename: pdfFilename, mimeType: 'application/pdf' });

  return {
    slides: slideResults,
    zip_url: `/files/${zipFilename}`,
    pdf_url: `/files/${pdfFilename}`,
  };
}

async function generateCarousel(post, brand = {}, ctx = {}) {
  const content = await extractCarouselContent(post);
  return renderCarousel(post, brand, content, ctx);
}

/**
 * One PDF page per slide PNG buffer (LinkedIn document / swipeable PDF post).
 * @param {Buffer[]} pngBuffers
 */
async function buildCarouselPdfFromBuffers(pngBuffers) {
  const pdfDoc = await PDFDocument.create();
  for (const pngBytes of pngBuffers) {
    const image = await pdfDoc.embedPng(pngBytes);
    const { width, height } = image;
    const page = pdfDoc.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
  }
  return Buffer.from(await pdfDoc.save());
}

function buildSlideSvg(slide, slideNum, totalSlides, brand = {}) {
  const BG_SLIDE  = brand.bg     || BG;
  const AC        = brand.accent || ACCENT;
  const TX        = brand.text   || TEXT;

  const isTitle = slide.type === 'title';
  const isClosing = slide.type === 'closing';

  // Title uses 72px font (~38px/char) — wrap at 20 chars (~760px) for balanced margins.
  // Content/closing uses 56px font (~30px/char) — can fit more chars per line.
  const headlineMaxChars = isTitle ? 20 : 22;
  const headlineLines = wrapText(slide.headline || '', headlineMaxChars);
  const bodyLines = slide.body ? wrapText(slide.body, 38) : [];

  const headlineFontSize = isTitle ? 72 : 56;
  const headlineLineHeight = isTitle ? 86 : 68;
  const bodyFontSize = 36;
  const bodyLineHeight = 52;

  const headlineBlockH = headlineLines.length * headlineLineHeight;
  const bodyBlockH = bodyLines.length > 0 ? bodyLines.length * bodyLineHeight + 40 : 0;
  const totalBlockH = headlineBlockH + bodyBlockH;
  const startY = (H - totalBlockH) / 2;

  // Horizontal padding: 80px each side → text area = 920px wide, centred at 540.
  const PAD = 80;
  const textClipDef = `<clipPath id="textClip"><rect x="${PAD}" y="0" width="${W - PAD * 2}" height="${H}"/></clipPath>`;

  const headlineXml = headlineLines.map((line, i) =>
    `<text x="540" y="${startY + i * headlineLineHeight}" font-family="system-ui,-apple-system,'Helvetica Neue',sans-serif" font-size="${headlineFontSize}" font-weight="600" letter-spacing="-0.5" fill="${TX}" text-anchor="middle" dominant-baseline="hanging" clip-path="url(#textClip)">${escapeXml(line)}</text>`
  ).join('\n  ');

  const bodyStartY = startY + headlineBlockH + 40;
  const bodyXml = bodyLines.map((line, i) =>
    `<text x="540" y="${bodyStartY + i * bodyLineHeight}" font-family="system-ui,-apple-system,'Helvetica Neue',sans-serif" font-size="${bodyFontSize}" font-weight="400" fill="${TX}" opacity="0.75" text-anchor="middle" dominant-baseline="hanging" clip-path="url(#textClip)">${escapeXml(line)}</text>`
  ).join('\n  ');

  // Accent treatment: title gets full bottom bar, others get left bar
  const accentXml = isTitle
    ? `<rect x="0" y="${H - 12}" width="${W}" height="12" fill="${AC}"/>`
    : `<rect x="60" y="${startY - 20}" width="8" height="${headlineBlockH + 40}" fill="${AC}" rx="4"/>`;

  // Slide counter
  const counterXml = `<text x="540" y="${H - 48}" font-family="system-ui,-apple-system,'Helvetica Neue',sans-serif" font-size="24" fill="${TX}" opacity="0.45" text-anchor="middle">${slideNum} / ${totalSlides}</text>`;

  // Swipe hint on title slide
  const swipeHint = isTitle
    ? `<text x="540" y="${H - 90}" font-family="system-ui,-apple-system,'Helvetica Neue',sans-serif" font-size="24" fill="${TX}" opacity="0.45" text-anchor="middle">Swipe →</text>`
    : '';

  // Brand mark bottom-right: logo > name > nothing (carousel has slide counter bottom-center)
  let brandXml = '';
  if (brand.logo) {
    brandXml = `<image href="${brand.logo}" x="${W - 188}" y="${H - 88}" width="140" height="44" preserveAspectRatio="xMidYMid meet"/>`;
  } else if (brand.name) {
    brandXml = `<text x="${W - 60}" y="${H - 56}" font-family="system-ui,-apple-system,'Helvetica Neue',sans-serif" font-size="22" font-weight="600" fill="${TX}" opacity="0.45" text-anchor="end">${escapeXml(brand.name)}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>${textClipDef}</defs>
  <rect width="${W}" height="${H}" fill="${BG_SLIDE}"/>
  ${accentXml}
  ${headlineXml}
  ${bodyXml}
  ${counterXml}
  ${swipeHint}
  ${brandXml}
</svg>`;
}

/**
 * Build a ZIP from in-memory PNG buffers. Returns a Buffer.
 * @param {Array<{ buffer: Buffer, filename: string }>} files
 */
function buildZipBuffer(files) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('data', chunk => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    for (const { buffer, filename } of files) {
      archive.append(buffer, { name: filename });
    }
    archive.finalize();
  });
}

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

module.exports = { generateCarousel, extractCarouselContent, renderCarousel };

'use strict';

const { PDFDocument } = require('pdf-lib');
const archiver = require('archiver');
const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const { extractJsonFromResponse, getAnthropicMessageText } = require('./voiceFingerprint');
const storage = require('./storage');
const { resolveFonts, buildTheme, renderToBuffer, W_SQUARE, H_SQUARE } = require('./satoriRenderer');

const W = W_SQUARE;
const H = W_SQUARE;

// ── AI extraction (unchanged) ───────────────────────────────────────────────

async function extractCarouselContent(post) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const client = new Anthropic({ apiKey });

  const carouselUserPrompt = `Break this LinkedIn post into slides for a carousel. Return ONLY valid JSON:
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
- Total slides: minimum 3, maximum 15 — use as many slides as the content warrants; do not compress multiple ideas into one slide
- Each body: 2-3 short sentences max. Never paste a full paragraph.
- Headlines: punchy, specific — not generic labels

POST:
${post.content}`;

  const slideMsg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 3000,
    messages: [{ role: 'user', content: carouselUserPrompt }],
  });

  let slidesData;
  const rawText = getAnthropicMessageText(slideMsg);
  try {
    slidesData = extractJsonFromResponse(rawText);
  } catch (e) {
    const retry = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 3000,
      messages: [
        { role: 'user', content: carouselUserPrompt },
        { role: 'assistant', content: slideMsg.content },
        { role: 'user', content: 'Return only valid JSON, no other text.' },
      ],
    });
    slidesData = extractJsonFromResponse(getAnthropicMessageText(retry));
  }

  const slides = slidesData.slides;
  if (!slides || slides.length < 3 || slides.length > 15) {
    throw new Error(`Expected 3-15 slides, got ${slides?.length}`);
  }

  return { slides };
}

// ── Satori slide builder ────────────────────────────────────────────────────

function buildSlideElement(theme, slide, slideNum, totalSlides) {
  const isTitle = slide.type === 'title';
  const isClosing = slide.type === 'closing';

  const headlineFontSize = isTitle ? 56 : 44;
  const bodyFontSize = 24;
  const counter = `${String(slideNum).padStart(2, '0')} / ${String(totalSlides).padStart(2, '0')}`;

  const children = [
    { type: 'div', props: { style: { position: 'absolute', top: -50, right: -50, width: 180, height: 180, borderRadius: 90, border: `1px solid ${theme.border}` } } },
  ];

  if (isTitle) {
    children.push(
      {
        type: 'div',
        props: {
          style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 },
          children: [
            { type: 'div', props: { style: { width: 28, height: 3, backgroundColor: theme.accent, borderRadius: 2 } } },
            theme.brandName ? { type: 'span', props: { style: { fontSize: 13, letterSpacing: 2, color: theme.accent, textTransform: 'uppercase', fontWeight: 600 }, children: theme.brandName } } : null,
          ].filter(Boolean),
        },
      },
      {
        type: 'div',
        props: {
          style: { display: 'flex', flex: 1, alignItems: 'center' },
          children: [{ type: 'span', props: { style: { fontSize: headlineFontSize, fontWeight: 700, color: theme.text, lineHeight: 1.15, letterSpacing: -1.5, fontFamily: theme.fontHeading }, children: slide.headline || '' } }],
        },
      },
      {
        type: 'div',
        props: {
          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
          children: [
            { type: 'span', props: { style: { fontSize: 16, color: theme.textMuted, opacity: 0.5 }, children: 'Swipe >' } },
            { type: 'span', props: { style: { fontSize: 14, color: theme.textMuted, opacity: 0.4, letterSpacing: 1 }, children: counter } },
          ],
        },
      },
    );
  } else {
    children.push(
      {
        type: 'div',
        props: {
          style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
          children: [
            { type: 'div', props: { style: { width: 32, height: 32, borderRadius: 16, backgroundColor: theme.badgeBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }, children: [{ type: 'span', props: { style: { fontSize: 14, fontWeight: 700, color: theme.badgeText }, children: String(slideNum) } }] } },
          ],
        },
      },
      {
        type: 'div',
        props: {
          style: { display: 'flex', flex: 1, flexDirection: 'column', justifyContent: 'center', gap: 20 },
          children: [
            {
              type: 'div',
              props: {
                style: { display: 'flex', gap: 16 },
                children: [
                  { type: 'div', props: { style: { width: 3, backgroundColor: theme.accent, borderRadius: 2, flexShrink: 0 } } },
                  { type: 'span', props: { style: { fontSize: headlineFontSize, fontWeight: 700, color: theme.text, lineHeight: 1.2, letterSpacing: -1, fontFamily: theme.fontHeading }, children: slide.headline || '' } },
                ],
              },
            },
            slide.body ? { type: 'span', props: { style: { fontSize: bodyFontSize, color: theme.textMuted, lineHeight: 1.55, fontFamily: theme.fontBody, padding: '0 8px' }, children: slide.body } } : null,
          ].filter(Boolean),
        },
      },
      {
        type: 'div',
        props: {
          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 12 },
          children: [
            theme.brandName ? { type: 'span', props: { style: { fontSize: 14, color: theme.textMuted, opacity: 0.35, letterSpacing: 1, fontWeight: 500 }, children: theme.brandName } } : { type: 'span', props: { children: '' } },
            { type: 'span', props: { style: { fontSize: 14, color: theme.textMuted, opacity: 0.4, letterSpacing: 1 }, children: counter } },
          ],
        },
      },
    );
  }

  children.push(
    { type: 'div', props: { style: { position: 'absolute', bottom: 0, left: 0, width: W, height: 3, backgroundImage: `linear-gradient(90deg, ${theme.accent}, transparent)` } } },
  );

  return {
    type: 'div',
    props: {
      style: {
        width: W,
        height: H,
        display: 'flex',
        flexDirection: 'column',
        padding: '48px 52px 36px',
        backgroundImage: theme.bgGradient,
        fontFamily: theme.fontBody,
        position: 'relative',
        overflow: 'hidden',
      },
      children,
    },
  };
}

// ── Render pipeline ─────────────────────────────────────────────────────────

async function renderCarousel(post, brand = {}, content, ctx = {}) {
  const { userId, tenantId } = ctx;
  const { slides } = content;
  const theme = buildTheme(brand, 'dark');
  const fonts = await resolveFonts(brand);

  const timestamp = Date.now();
  const pngBuffers = [];
  const slideResults = [];

  for (let i = 0; i < slides.length; i++) {
    const element = buildSlideElement(theme, slides[i], i + 1, slides.length);
    const pngBuffer = await renderToBuffer(element, fonts);
    const filename = `carousel_${post.id}_${timestamp}_slide${i + 1}.png`;
    await storage.upload(pngBuffer, { tenantId, userId, type: 'generated', filename, mimeType: 'image/png' });
    pngBuffers.push({ buffer: pngBuffer, filename });
    slideResults.push({ png_url: `/files/${filename}` });
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

module.exports = { generateCarousel, extractCarouselContent, renderCarousel };

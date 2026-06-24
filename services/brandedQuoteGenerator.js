'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const storage = require('./storage');
const { getAnthropicMessageText } = require('./voiceFingerprint');
const { resolveFonts, buildTheme, renderToBuffer, W_SQUARE, H_SQUARE } = require('./satoriRenderer');

const W = W_SQUARE;
const H = H_SQUARE;

async function extractBrandedQuoteContent(post) {
  return { quote: await extractBrandedQuoteText(post.content || '') };
}

async function extractBrandedQuoteText(content) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
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
    const raw = getAnthropicMessageText(extractMsg);
    if (raw) return sanitizeExtractedQuote(raw);
  } catch (err) {
    console.warn('[brandedQuote] extract failed:', err.message);
  }
  return fallbackBrandedQuoteText(content);
}

function sanitizeExtractedQuote(s) {
  return s.replace(/^[\s"'""'']+|[\s"'""'']+$/g, '').replace(/\n+/g, ' ').trim();
}

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
  return firstPara.slice(0, 160);
}

function buildBrandedQuoteElement(theme, quote, linkedin) {
  const avatarEl = linkedin.photoDataUri
    ? { type: 'img', props: { src: linkedin.photoDataUri, width: 72, height: 72, style: { borderRadius: 36, objectFit: 'cover' } } }
    : { type: 'div', props: { style: { width: 72, height: 72, borderRadius: 36, backgroundColor: theme.accent, opacity: 0.3 } } };

  return {
    type: 'div',
    props: {
      style: {
        width: W,
        height: H,
        display: 'flex',
        flexDirection: 'column',
        padding: '60px 64px',
        backgroundImage: theme.bgGradient,
        fontFamily: theme.fontBody,
        position: 'relative',
        overflow: 'hidden',
      },
      children: [
        { type: 'div', props: { style: { position: 'absolute', top: -50, right: -50, width: 200, height: 200, borderRadius: 100, border: `1px solid ${theme.border}` } } },
        { type: 'div', props: { style: { position: 'absolute', bottom: 60, left: -30, width: 140, height: 140, borderRadius: 70, border: `1px solid ${theme.border}` } } },
        {
          type: 'div',
          props: {
            style: { display: 'flex', alignItems: 'center', gap: 16, marginBottom: 32 },
            children: [
              avatarEl,
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column', gap: 2 },
                  children: [
                    { type: 'span', props: { style: { fontSize: 24, fontWeight: 700, color: theme.text, fontFamily: theme.fontHeading }, children: linkedin.name || '' } },
                    theme.brandName ? { type: 'span', props: { style: { fontSize: 16, color: theme.textMuted, fontFamily: theme.fontBody }, children: theme.brandName } } : null,
                  ].filter(Boolean),
                },
              },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flex: 1, alignItems: 'center', padding: '0 8px' },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', gap: 20 },
                  children: [
                    { type: 'div', props: { style: { width: 4, backgroundColor: theme.accent, borderRadius: 2, flexShrink: 0 } } },
                    { type: 'span', props: { style: { fontSize: 36, fontWeight: 500, color: theme.text, lineHeight: 1.45, fontFamily: theme.fontHeading, letterSpacing: -0.3 }, children: quote } },
                  ],
                },
              },
            ],
          },
        },
        theme.brandLogo ? {
          type: 'div',
          props: {
            style: { display: 'flex', justifyContent: 'center', paddingTop: 20, marginTop: 'auto' },
            children: [{ type: 'img', props: { src: theme.brandLogo, width: 140, height: 36, style: { objectFit: 'contain', opacity: 0.5 } } }],
          },
        } : null,
        { type: 'div', props: { style: { position: 'absolute', bottom: 0, left: 0, width: W, height: 3, backgroundImage: `linear-gradient(90deg, ${theme.accent}, transparent)` } } },
      ].filter(Boolean),
    },
  };
}

async function renderBrandedQuote(post, brand = {}, content, linkedin = {}, ctx = {}) {
  const { userId, tenantId } = ctx;
  const theme = buildTheme(brand, 'dark');
  const fonts = await resolveFonts(brand);
  const element = buildBrandedQuoteElement(theme, content.quote, linkedin);
  const pngBuffer = await renderToBuffer(element, fonts);
  const filename = `branded_quote_${post.id}_${Date.now()}.png`;
  await storage.upload(pngBuffer, { tenantId, userId, type: 'generated', filename, mimeType: 'image/png' });
  return { png_url: `/files/${filename}` };
}

async function generateBrandedQuote(post, brand = {}, linkedin = {}, ctx = {}) {
  const content = await extractBrandedQuoteContent(post);
  return renderBrandedQuote(post, brand, content, linkedin, ctx);
}

module.exports = { generateBrandedQuote, extractBrandedQuoteContent, renderBrandedQuote };

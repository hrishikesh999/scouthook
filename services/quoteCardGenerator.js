'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const storage = require('./storage');
const { getAnthropicMessageText } = require('./voiceFingerprint');
const { resolveFonts, buildTheme, renderToBuffer, W_SQUARE, H_SQUARE } = require('./satoriRenderer');

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

function buildQuoteCardElement(theme, quote) {
  return {
    type: 'div',
    props: {
      style: {
        width: W_SQUARE,
        height: H_SQUARE,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '80px 72px',
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
            style: { display: 'flex', flexDirection: 'column', gap: 0, maxWidth: 900 },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', gap: 24 },
                  children: [
                    { type: 'div', props: { style: { width: 4, backgroundColor: theme.accent, borderRadius: 2, flexShrink: 0 } } },
                    { type: 'span', props: { style: { fontSize: 44, fontWeight: 500, color: theme.text, lineHeight: 1.4, letterSpacing: -0.5, fontFamily: theme.fontHeading }, children: `"${quote}"` } },
                  ],
                },
              },
            ],
          },
        },
        theme.brandName ? {
          type: 'div',
          props: {
            style: { display: 'flex', justifyContent: 'center', position: 'absolute', bottom: 40, left: 0, width: W_SQUARE },
            children: [{ type: 'span', props: { style: { fontSize: 16, color: theme.textMuted, opacity: 0.4, letterSpacing: 1.5, fontWeight: 500 }, children: theme.brandName } }],
          },
        } : null,
        { type: 'div', props: { style: { position: 'absolute', bottom: 0, left: 0, width: W_SQUARE, height: 3, backgroundImage: `linear-gradient(90deg, ${theme.accent}, transparent)` } } },
      ].filter(Boolean),
    },
  };
}

async function renderQuoteCard(post, brand = {}, content, ctx = {}) {
  const { userId, tenantId } = ctx;
  const theme = buildTheme(brand, 'dark');
  const fonts = await resolveFonts(brand);
  const element = buildQuoteCardElement(theme, content.quote);
  const pngBuffer = await renderToBuffer(element, fonts);
  const filename = `quote_${post.id}_${Date.now()}.png`;
  await storage.upload(pngBuffer, { tenantId, userId, type: 'generated', filename, mimeType: 'image/png' });
  return { png_url: `/files/${filename}` };
}

async function generateQuoteCard(post, brand = {}, ctx = {}) {
  const content = await extractQuoteCardContent(post);
  return renderQuoteCard(post, brand, content, ctx);
}

module.exports = { generateQuoteCard, extractQuoteCardContent, renderQuoteCard };

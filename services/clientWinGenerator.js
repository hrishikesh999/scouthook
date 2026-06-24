'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const storage = require('./storage');
const { extractJsonFromResponse, getAnthropicMessageText } = require('./voiceFingerprint');
const { resolveFonts, buildTheme, renderToBuffer, W_SQUARE, H_SQUARE } = require('./satoriRenderer');

async function extractClientWinContent(post) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');
  const client = new Anthropic({ apiKey });

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `Extract the client result or win from this LinkedIn post. Return ONLY valid JSON:
{
  "clientNiche": "what the client does (e.g. 'SaaS Founder', 'Executive Coach')",
  "result": "the outcome achieved (e.g. 'Grew revenue from 3L to 18L/month')",
  "timeframe": "how long it took (e.g. '90 days')",
  "method": "1-sentence summary of what changed (optional)"
}

If the post is not about a client result, extract the most relevant achievement.
Use plain ASCII only — no currency symbols or special arrows.

POST:
${post.content}`,
    }],
  });

  let data;
  const raw = getAnthropicMessageText(msg);
  try {
    data = extractJsonFromResponse(raw);
  } catch {
    return { clientNiche: '', result: 'Result not found', timeframe: '', method: '' };
  }
  return {
    clientNiche: String(data.clientNiche || '').slice(0, 50),
    result: String(data.result || '').slice(0, 100),
    timeframe: String(data.timeframe || '').slice(0, 30),
    method: data.method ? String(data.method).slice(0, 150) : undefined,
  };
}

function buildClientWinElement(theme, content) {
  const items = [
    { label: 'CLIENT', value: content.clientNiche },
    { label: 'RESULT', value: content.result },
    { label: 'TIMEFRAME', value: content.timeframe },
  ].filter(item => item.value);

  return {
    type: 'div',
    props: {
      style: {
        width: W_SQUARE, height: H_SQUARE, display: 'flex', flexDirection: 'column',
        padding: '56px 60px', backgroundImage: theme.bgGradient, fontFamily: theme.fontBody,
        position: 'relative', overflow: 'hidden',
      },
      children: [
        { type: 'div', props: { style: { position: 'absolute', top: -50, right: -50, width: 200, height: 200, borderRadius: 100, border: `1px solid ${theme.border}` } } },
        { type: 'div', props: { style: { position: 'absolute', bottom: 60, left: -30, width: 140, height: 140, borderRadius: 70, border: `1px solid ${theme.border}` } } },
        {
          type: 'div',
          props: {
            style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 32 },
            children: [
              { type: 'div', props: { style: { width: 32, height: 3, backgroundColor: theme.accent, borderRadius: 2 } } },
              { type: 'span', props: { style: { fontSize: 13, letterSpacing: 3, color: theme.accent, textTransform: 'uppercase', fontWeight: 600 }, children: 'CLIENT WIN' } },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', justifyContent: 'center', flex: 1, gap: 28 },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', gap: 20 },
                  children: [
                    { type: 'div', props: { style: { width: 4, backgroundColor: theme.accent, borderRadius: 2, flexShrink: 0 } } },
                    { type: 'span', props: { style: { fontSize: 42, fontWeight: 700, color: theme.text, lineHeight: 1.2, letterSpacing: -1, fontFamily: theme.fontHeading }, children: content.result } },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexWrap: 'wrap', gap: 20 },
                  children: items.map(item => ({
                    type: 'div',
                    props: {
                      style: { display: 'flex', flexDirection: 'column', gap: 4, backgroundColor: theme.cardBg, borderRadius: 12, padding: '16px 20px', border: `1px solid ${theme.cardBorder}` },
                      children: [
                        { type: 'span', props: { style: { fontSize: 11, letterSpacing: 2, color: theme.textMuted, textTransform: 'uppercase', fontWeight: 600 }, children: item.label } },
                        { type: 'span', props: { style: { fontSize: 18, fontWeight: 600, color: theme.text, fontFamily: theme.fontHeading }, children: item.value } },
                      ],
                    },
                  })),
                },
              },
              content.method ? {
                type: 'span',
                props: { style: { fontSize: 17, color: theme.textMuted, lineHeight: 1.5, fontFamily: theme.fontBody }, children: content.method },
              } : null,
            ].filter(Boolean),
          },
        },
        theme.brandName ? {
          type: 'div',
          props: {
            style: { display: 'flex', justifyContent: 'center', paddingTop: 16, marginTop: 'auto' },
            children: [{ type: 'span', props: { style: { fontSize: 16, color: theme.textMuted, opacity: 0.4, letterSpacing: 1.5, fontWeight: 500 }, children: theme.brandName } }],
          },
        } : null,
        { type: 'div', props: { style: { position: 'absolute', bottom: 0, left: 0, width: W_SQUARE, height: 3, backgroundImage: `linear-gradient(90deg, ${theme.accent}, transparent)` } } },
      ].filter(Boolean),
    },
  };
}

async function renderClientWin(post, brand = {}, content, ctx = {}, variant = 'dark') {
  const { userId, tenantId } = ctx;
  const theme = buildTheme(brand, variant);
  const fonts = await resolveFonts(brand);
  const element = buildClientWinElement(theme, content);
  const pngBuffer = await renderToBuffer(element, fonts);
  const filename = `client_win_${post.id}_${Date.now()}.png`;
  await storage.upload(pngBuffer, { tenantId, userId, type: 'generated', filename, mimeType: 'image/png' });
  return { png_url: `/files/${filename}` };
}

async function generateClientWin(post, brand = {}, ctx = {}, variant = 'dark') {
  const content = await extractClientWinContent(post);
  return renderClientWin(post, brand, content, ctx, variant);
}

module.exports = { extractClientWinContent, renderClientWin, generateClientWin };

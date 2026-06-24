'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const storage = require('./storage');
const { extractJsonFromResponse, getAnthropicMessageText } = require('./voiceFingerprint');
const { resolveFonts, buildTheme, renderToBuffer, W_SQUARE, H_SQUARE } = require('./satoriRenderer');

async function extractMetricsContent(post) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');
  const client = new Anthropic({ apiKey });

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Extract the single most impressive metric or result from this LinkedIn post. Return ONLY valid JSON:
{
  "value": "the big number or result (plain ASCII, no currency symbols, no arrows — e.g. '3L to 18L' not '₹3L → ₹18L')",
  "label": "what the number means (one line, max 10 words)",
  "context": "who or what category (2-5 words, e.g. 'SaaS Founder - B2B')"
}

POST:
${post.content}`,
    }],
  });

  let data;
  const raw = getAnthropicMessageText(msg);
  try {
    data = extractJsonFromResponse(raw);
  } catch {
    return { value: '---', label: 'Could not extract metric', context: '' };
  }
  return {
    value: String(data.value || '---').slice(0, 30),
    label: String(data.label || '').slice(0, 80),
    context: data.context ? String(data.context).slice(0, 40) : undefined,
  };
}

function buildMetricsElement(theme, content) {
  return {
    type: 'div',
    props: {
      style: {
        width: W_SQUARE, height: H_SQUARE, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', padding: '60px 64px',
        backgroundImage: theme.bgGradient, fontFamily: theme.fontBody,
        position: 'relative', overflow: 'hidden',
      },
      children: [
        { type: 'div', props: { style: { position: 'absolute', top: -50, right: -50, width: 200, height: 200, borderRadius: 100, border: `1px solid ${theme.border}` } } },
        { type: 'div', props: { style: { position: 'absolute', bottom: 60, left: -30, width: 140, height: 140, borderRadius: 70, border: `1px solid ${theme.border}` } } },
        content.context ? { type: 'span', props: { style: { fontSize: 14, letterSpacing: 2.5, color: theme.textMuted, textTransform: 'uppercase', fontWeight: 500, marginBottom: 16 }, children: content.context } } : null,
        { type: 'div', props: { style: { width: 48, height: 3, backgroundColor: theme.accent, borderRadius: 2, marginBottom: 20 } } },
        { type: 'span', props: { style: { fontSize: 80, fontWeight: 700, color: theme.text, letterSpacing: -3, fontFamily: theme.fontHeading, lineHeight: 1.1, textAlign: 'center' }, children: content.value } },
        { type: 'span', props: { style: { fontSize: 24, color: theme.textMuted, fontFamily: theme.fontBody, marginTop: 16, textAlign: 'center' }, children: content.label } },
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

async function renderMetricsCard(post, brand = {}, content, ctx = {}, variant = 'accent') {
  const { userId, tenantId } = ctx;
  const theme = buildTheme(brand, variant);
  const fonts = await resolveFonts(brand);
  const element = buildMetricsElement(theme, content);
  const pngBuffer = await renderToBuffer(element, fonts);
  const filename = `metrics_${post.id}_${Date.now()}.png`;
  await storage.upload(pngBuffer, { tenantId, userId, type: 'generated', filename, mimeType: 'image/png' });
  return { png_url: `/files/${filename}` };
}

async function generateMetricsCard(post, brand = {}, ctx = {}, variant = 'accent') {
  const content = await extractMetricsContent(post);
  return renderMetricsCard(post, brand, content, ctx, variant);
}

module.exports = { extractMetricsContent, renderMetricsCard, generateMetricsCard };

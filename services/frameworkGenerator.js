'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const storage = require('./storage');
const { extractJsonFromResponse, getAnthropicMessageText } = require('./voiceFingerprint');
const { resolveFonts, buildTheme, renderToBuffer, W_SQUARE, H_SQUARE } = require('./satoriRenderer');

async function extractFrameworkContent(post) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');
  const client = new Anthropic({ apiKey });

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Extract a framework or step-by-step process from this LinkedIn post. Return ONLY valid JSON:
{
  "name": "Framework name (2-6 words)",
  "steps": [
    { "title": "Step name (2-4 words)", "description": "One sentence explaining this step" },
    ...
  ]
}

Rules:
- Extract 3-6 steps maximum
- Each step title should be concise (2-4 words)
- Each description should be one short sentence
- If the post describes a process, methodology, or system — extract that
- If not, create a logical framework from the post's key ideas

POST:
${post.content}`,
    }],
  });

  let data;
  const raw = getAnthropicMessageText(msg);
  try {
    data = extractJsonFromResponse(raw);
  } catch {
    return { name: 'Framework', steps: [{ title: 'Step 1', description: 'Could not extract framework' }] };
  }
  const steps = Array.isArray(data.steps) ? data.steps.slice(0, 6) : [];
  return {
    name: String(data.name || 'Framework').slice(0, 60),
    steps: steps.map(s => ({
      title: String(s.title || '').slice(0, 40),
      description: s.description ? String(s.description).slice(0, 120) : undefined,
    })),
  };
}

function buildFrameworkElement(theme, content) {
  const { name, steps } = content;
  const isHorizontal = steps.length <= 4;

  function stepNode(step, index, total) {
    return {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          flex: 1,
          maxWidth: isHorizontal ? 220 : undefined,
        },
        children: [
          {
            type: 'div',
            props: {
              style: {
                width: isHorizontal ? 56 : 48,
                height: isHorizontal ? 56 : 48,
                borderRadius: isHorizontal ? 28 : 24,
                backgroundColor: theme.accent,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              },
              children: [{ type: 'span', props: { style: { fontSize: isHorizontal ? 22 : 18, fontWeight: 700, color: theme.badgeText }, children: String(index + 1) } }],
            },
          },
          { type: 'span', props: { style: { fontSize: isHorizontal ? 18 : 20, fontWeight: 700, color: theme.text, textAlign: 'center', fontFamily: theme.fontHeading, lineHeight: 1.25 }, children: step.title } },
          step.description ? { type: 'span', props: { style: { fontSize: isHorizontal ? 13 : 14, color: theme.textMuted, textAlign: 'center', lineHeight: 1.45, fontFamily: theme.fontBody }, children: step.description } } : null,
        ].filter(Boolean),
      },
    };
  }

  function arrow(horizontal) {
    if (horizontal) {
      return {
        type: 'div',
        props: {
          style: { display: 'flex', alignItems: 'center', flexShrink: 0, padding: '0 4px', marginTop: -20 },
          children: [
            { type: 'div', props: { style: { width: 24, height: 2, backgroundColor: theme.accent, opacity: 0.5 } } },
            { type: 'div', props: { style: { width: 0, height: 0, borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderLeft: `8px solid ${theme.accent}`, opacity: 0.5 } } },
          ],
        },
      };
    }
    return {
      type: 'div',
      props: {
        style: { display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, padding: '4px 0' },
        children: [
          { type: 'div', props: { style: { width: 2, height: 20, backgroundColor: theme.accent, opacity: 0.5 } } },
          { type: 'div', props: { style: { width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: `8px solid ${theme.accent}`, opacity: 0.5 } } },
        ],
      },
    };
  }

  const stepsWithArrows = [];
  steps.forEach((step, i) => {
    stepsWithArrows.push(stepNode(step, i, steps.length));
    if (i < steps.length - 1) stepsWithArrows.push(arrow(isHorizontal));
  });

  return {
    type: 'div',
    props: {
      style: {
        width: W_SQUARE, height: H_SQUARE, display: 'flex', flexDirection: 'column',
        padding: '52px 48px 40px', backgroundImage: theme.bgGradient, fontFamily: theme.fontBody,
        position: 'relative', overflow: 'hidden',
      },
      children: [
        { type: 'div', props: { style: { position: 'absolute', top: -50, right: -50, width: 200, height: 200, borderRadius: 100, border: `1px solid ${theme.border}` } } },
        { type: 'div', props: { style: { position: 'absolute', bottom: 60, left: -30, width: 140, height: 140, borderRadius: 70, border: `1px solid ${theme.border}` } } },
        {
          type: 'div',
          props: {
            style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 },
            children: [
              { type: 'div', props: { style: { width: 32, height: 3, backgroundColor: theme.accent, borderRadius: 2 } } },
              { type: 'span', props: { style: { fontSize: 13, letterSpacing: 3, color: theme.accent, textTransform: 'uppercase', fontWeight: 600 }, children: 'FRAMEWORK' } },
            ],
          },
        },
        { type: 'span', props: { style: { fontSize: 40, fontWeight: 700, color: theme.text, lineHeight: 1.15, letterSpacing: -1, fontFamily: theme.fontHeading, marginBottom: 32 }, children: name } },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: isHorizontal ? 'row' : 'column',
              alignItems: isHorizontal ? 'flex-start' : 'center',
              justifyContent: 'center',
              flex: 1,
              gap: 0,
            },
            children: stepsWithArrows,
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

async function renderFramework(post, brand = {}, content, ctx = {}, variant = 'dark') {
  const { userId, tenantId } = ctx;
  const theme = buildTheme(brand, variant);
  const fonts = await resolveFonts(brand);
  const element = buildFrameworkElement(theme, content);
  const pngBuffer = await renderToBuffer(element, fonts);
  const filename = `framework_${post.id}_${Date.now()}.png`;
  await storage.upload(pngBuffer, { tenantId, userId, type: 'generated', filename, mimeType: 'image/png' });
  return { png_url: `/files/${filename}` };
}

async function generateFramework(post, brand = {}, ctx = {}, variant = 'dark') {
  const content = await extractFrameworkContent(post);
  return renderFramework(post, brand, content, ctx, variant);
}

module.exports = { extractFrameworkContent, renderFramework, generateFramework };

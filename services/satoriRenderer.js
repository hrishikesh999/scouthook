'use strict';

const satori = require('satori').default;
const sharp = require('sharp');
const { getIconElement } = require('./iconLibrary');

const W_SQUARE = 1080;
const H_SQUARE = 1080;
const W_PORTRAIT = 1080;
const H_PORTRAIT = 1350;

// ── Color helpers ───────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function lighten(hex, amount) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
}

function darken(hex, amount) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r * (1 - amount), g * (1 - amount), b * (1 - amount));
}

// ── Font cache with TTL ─────────────────────────────────────────────────────

const FONT_TTL_MS = 30 * 60 * 1000;
const fontCache = new Map();

async function loadFont(fontName, weight = 400) {
  const key = `${fontName}:${weight}`;
  const cached = fontCache.get(key);
  if (cached && Date.now() - cached.ts < FONT_TTL_MS) return cached.entry;

  const slug = fontName.toLowerCase().replace(/\s+/g, '-');
  const ttfUrl = `https://cdn.jsdelivr.net/fontsource/fonts/${slug}@latest/latin-${weight}-normal.ttf`;
  try {
    const fontRes = await fetch(ttfUrl);
    if (!fontRes.ok) {
      fontCache.set(key, { entry: null, ts: Date.now() });
      return null;
    }
    const buf = Buffer.from(await fontRes.arrayBuffer());
    const entry = { name: fontName, data: buf, weight, style: 'normal' };
    fontCache.set(key, { entry, ts: Date.now() });
    return entry;
  } catch (err) {
    console.warn(`[satoriRenderer] font fetch failed ${fontName}:${weight}:`, err.message);
    fontCache.set(key, { entry: null, ts: Date.now() });
    return null;
  }
}

async function resolveFonts(brand) {
  const heading = brand.font_heading || 'Inter';
  const body = brand.font_body || heading;
  const names = [...new Set([heading, body])];
  const weights = [400, 500, 600, 700];

  const promises = [];
  for (const name of names) {
    for (const w of weights) {
      promises.push(loadFont(name, w).catch(() => null));
    }
  }
  // Always load Noto Sans for non-Latin glyph coverage (arrows, currency symbols, etc.)
  for (const w of [400, 700]) {
    promises.push(loadFont('Noto Sans', w).catch(() => null));
  }

  const results = await Promise.all(promises);
  const fonts = results.filter(Boolean);

  if (fonts.length === 0) {
    const fallback = await loadFont('Inter', 400);
    if (fallback) fonts.push(fallback);
  }
  return fonts;
}

// ── Theme system ────────────────────────────────────────────────────────────

function resolveThemeFonts(brand) {
  return {
    fontHeading: brand.font_heading || 'Inter',
    fontBody: brand.font_body || brand.font_heading || 'Inter',
    brandName: brand.name || null,
    brandLogo: brand.logo || null,
  };
}

function buildTheme(brand, variant = 'dark') {
  const accent = brand.accent || '#0D7A5F';
  const shared = resolveThemeFonts(brand);

  if (variant === 'light') {
    return {
      ...shared,
      bg: '#F9FAFB',
      bgGradient: 'linear-gradient(155deg, #FFFFFF 0%, #F5F5F4 50%, #E7E5E4 100%)',
      cardBg: '#FFFFFF',
      cardBorder: 'rgba(0,0,0,0.08)',
      cardShadow: '0 1px 3px rgba(0,0,0,0.06)',
      text: '#111827',
      textMuted: '#6B7280',
      accent,
      border: 'rgba(0,0,0,0.06)',
      badgeBg: accent,
      badgeText: '#FFFFFF',
    };
  }

  if (variant === 'accent') {
    return {
      ...shared,
      bg: accent,
      bgGradient: `linear-gradient(155deg, ${accent} 0%, ${darken(accent, 0.2)} 100%)`,
      cardBg: 'rgba(255,255,255,0.12)',
      cardBorder: 'rgba(255,255,255,0.12)',
      cardShadow: 'none',
      text: '#FFFFFF',
      textMuted: 'rgba(255,255,255,0.75)',
      accent: '#FFFFFF',
      border: 'rgba(255,255,255,0.12)',
      badgeBg: 'rgba(255,255,255,0.25)',
      badgeText: '#FFFFFF',
    };
  }

  const bg = brand.bg || '#0F1A3C';
  return {
    ...shared,
    bg,
    bgGradient: brand.bg_type === 'gradient' && brand.bg_gradient
      ? `linear-gradient(${brand.bg_gradient.angle || 155}deg, ${brand.bg_gradient.from || bg} 0%, ${brand.bg_gradient.to || bg} 100%)`
      : `linear-gradient(155deg, ${bg} 0%, ${lighten(bg, 0.06)} 40%, ${lighten(bg, 0.1)} 100%)`,
    cardBg: 'rgba(255,255,255,0.06)',
    cardBorder: 'rgba(255,255,255,0.06)',
    cardShadow: 'none',
    text: brand.text || '#F0F4FF',
    textMuted: brand.secondary_text || '#8A9CC0',
    accent,
    border: 'rgba(255,255,255,0.06)',
    badgeBg: accent,
    badgeText: '#FFFFFF',
  };
}

// ── Component library ───────────────────────────────────────────────────────

function heroTitle(theme, { tag, title, subtitle }) {
  const children = [];
  if (tag) {
    children.push({
      type: 'div',
      props: {
        style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 },
        children: [
          { type: 'div', props: { style: { width: 32, height: 3, backgroundColor: theme.accent, borderRadius: 2 } } },
          { type: 'span', props: { style: { fontSize: 13, letterSpacing: 3, color: theme.accent, textTransform: 'uppercase', fontWeight: 600, fontFamily: theme.fontBody }, children: tag } },
        ],
      },
    });
  }
  children.push(
    { type: 'span', props: { style: { fontSize: 44, fontWeight: 700, color: theme.text, lineHeight: 1.12, letterSpacing: -1.5, fontFamily: theme.fontHeading }, children: title } },
  );
  if (subtitle) {
    children.push(
      { type: 'div', props: { style: { width: 24, height: 2, backgroundColor: theme.accent, borderRadius: 1, marginTop: 14, marginBottom: 6 } } },
      { type: 'span', props: { style: { fontSize: 18, color: theme.textMuted, lineHeight: 1.4, fontFamily: theme.fontBody }, children: subtitle } },
    );
  }
  return { type: 'div', props: { style: { display: 'flex', flexDirection: 'column', marginBottom: 24 }, children } };
}

function iconCard(theme, { title, body, index, icon }) {
  const iconEl = icon ? getIconElement(icon, theme.accent, 22) : null;
  const badgeEl = typeof index === 'number' ? {
    type: 'div',
    props: {
      style: { width: 28, height: 28, borderRadius: 14, backgroundColor: theme.badgeBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
      children: [{ type: 'span', props: { style: { fontSize: 13, fontWeight: 700, color: theme.badgeText }, children: String(index + 1) } }],
    },
  } : null;
  const leadEl = iconEl || badgeEl || { type: 'div', props: { style: { width: 28, height: 28, borderRadius: 14, backgroundColor: theme.accent, opacity: 0.2, flexShrink: 0 } } };

  return {
    type: 'div',
    props: {
      style: {
        backgroundColor: theme.cardBg,
        borderRadius: 14,
        padding: '20px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        border: `1px solid ${theme.cardBorder}`,
        boxShadow: theme.cardShadow,
        flex: 1,
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', alignItems: 'center', gap: 10 },
            children: [leadEl, { type: 'span', props: { style: { fontSize: 22, fontWeight: 700, color: theme.text, fontFamily: theme.fontHeading, lineHeight: 1.2 }, children: title || '' } }],
          },
        },
        { type: 'span', props: { style: { fontSize: 15, color: theme.textMuted, lineHeight: 1.55, fontFamily: theme.fontBody }, children: body || '' } },
      ],
    },
  };
}

function numberedRow(theme, { title, body, index, icon }) {
  const iconEl = icon ? getIconElement(icon, theme.badgeText, 20) : null;
  const badgeContent = iconEl
    ? [iconEl]
    : [{ type: 'span', props: { style: { fontSize: 16, fontWeight: 700, color: theme.badgeText }, children: String((index || 0) + 1) } }];

  return {
    type: 'div',
    props: {
      style: { display: 'flex', gap: 16, alignItems: 'flex-start' },
      children: [
        {
          type: 'div',
          props: {
            style: { width: 38, height: 38, borderRadius: 19, backgroundColor: theme.badgeBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2 },
            children: badgeContent,
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1 },
            children: [
              { type: 'span', props: { style: { fontSize: 21, fontWeight: 700, color: theme.text, fontFamily: theme.fontHeading, lineHeight: 1.25 }, children: title || '' } },
              body ? { type: 'span', props: { style: { fontSize: 15, color: theme.textMuted, lineHeight: 1.55, fontFamily: theme.fontBody }, children: body } } : null,
            ].filter(Boolean),
          },
        },
      ],
    },
  };
}

function metricCard(theme, { value, label, context }) {
  return {
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 },
      children: [
        context ? { type: 'span', props: { style: { fontSize: 14, letterSpacing: 2.5, color: theme.textMuted, textTransform: 'uppercase', fontWeight: 500, fontFamily: theme.fontBody }, children: context } } : null,
        { type: 'div', props: { style: { width: 48, height: 3, backgroundColor: theme.accent, borderRadius: 2, marginTop: 4, marginBottom: 4 } } },
        { type: 'span', props: { style: { fontSize: 72, fontWeight: 700, color: theme.text, letterSpacing: -2, fontFamily: theme.fontHeading, lineHeight: 1.1 }, children: value || '' } },
        { type: 'span', props: { style: { fontSize: 24, color: theme.textMuted, fontFamily: theme.fontBody, lineHeight: 1.3 }, children: label || '' } },
      ].filter(Boolean),
    },
  };
}

function bulletList(theme, { items = [] }) {
  return {
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'column', gap: 12 },
      children: items.map(item => ({
        type: 'div',
        props: {
          style: { display: 'flex', gap: 12, alignItems: 'flex-start' },
          children: [
            { type: 'div', props: { style: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.accent, flexShrink: 0, marginTop: 8 } } },
            { type: 'span', props: { style: { fontSize: 17, color: theme.text, lineHeight: 1.55, fontFamily: theme.fontBody }, children: item } },
          ],
        },
      })),
    },
  };
}

function quoteBlock(theme, { quote, attribution }) {
  return {
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'column', gap: 20, paddingLeft: 28, borderLeft: `4px solid ${theme.accent}` },
      children: [
        { type: 'span', props: { style: { fontSize: 32, fontWeight: 500, color: theme.text, lineHeight: 1.45, fontFamily: theme.fontHeading, letterSpacing: -0.5 }, children: `“${quote}”` } },
        attribution ? {
          type: 'div',
          props: {
            style: { display: 'flex', alignItems: 'center', gap: 10 },
            children: [
              { type: 'div', props: { style: { width: 20, height: 1, backgroundColor: theme.textMuted, opacity: 0.5 } } },
              { type: 'span', props: { style: { fontSize: 16, color: theme.textMuted, fontFamily: theme.fontBody, fontWeight: 500 }, children: attribution } },
            ],
          },
        } : null,
      ].filter(Boolean),
    },
  };
}

function brandFooter(theme) {
  if (!theme.brandName && !theme.brandLogo) return null;

  const children = [];
  if (theme.brandLogo) {
    children.push({ type: 'img', props: { src: theme.brandLogo, width: 120, height: 32, style: { objectFit: 'contain', opacity: 0.6 } } });
  } else {
    children.push({ type: 'span', props: { style: { fontSize: 16, color: theme.textMuted, opacity: 0.4, letterSpacing: 1.5, fontWeight: 500, fontFamily: theme.fontBody }, children: theme.brandName } });
  }

  return {
    type: 'div',
    props: {
      style: { display: 'flex', justifyContent: 'center', alignItems: 'center', paddingTop: 20, marginTop: 'auto' },
      children,
    },
  };
}

function decorativeCircles(theme) {
  return [
    { type: 'div', props: { style: { position: 'absolute', top: -50, right: -50, width: 200, height: 200, borderRadius: 100, border: `1px solid ${theme.border}` } } },
    { type: 'div', props: { style: { position: 'absolute', bottom: 60, left: -30, width: 140, height: 140, borderRadius: 70, border: `1px solid ${theme.border}` } } },
  ];
}

function accentLine(theme) {
  return {
    type: 'div',
    props: {
      style: { position: 'absolute', bottom: 0, left: 0, width: W_SQUARE, height: 3, backgroundImage: `linear-gradient(90deg, ${theme.accent}, transparent)` },
    },
  };
}

// ── Layout builders ─────────────────────────────────────────────────────────

const COMPONENT_MAP = {
  'hero-title': heroTitle,
  'icon-card': iconCard,
  'numbered-row': numberedRow,
  'metric-card': metricCard,
  'bullet-list': bulletList,
  'quote-block': quoteBlock,
  'brand-footer': brandFooter,
};

function buildLayout(theme, layout) {
  const { type, columns = 2, items = [], title, subtitle, tag, showBrandFooter = true } = layout;
  const safeItems = Array.isArray(items) ? items : [];
  const children = [];

  children.push(...decorativeCircles(theme));

  if (title) {
    children.push(heroTitle(theme, { tag, title, subtitle }));
  }

  if (type === 'card-grid') {
    const cardWidth = columns === 3 ? '30%' : columns === 4 ? '22%' : '46%';
    children.push({
      type: 'div',
      props: {
        style: { display: 'flex', flexWrap: 'wrap', gap: 14, flex: 1, alignContent: 'flex-start' },
        children: safeItems.map((item, i) => ({
          type: 'div',
          props: {
            style: { display: 'flex', width: cardWidth },
            children: [iconCard(theme, { ...item, index: i })],
          },
        })),
      },
    });

  } else if (type === 'numbered-list') {
    const gap = safeItems.length <= 4 ? 28 : safeItems.length <= 6 ? 22 : safeItems.length <= 8 ? 16 : 12;
    children.push({
      type: 'div',
      props: {
        style: { display: 'flex', flexDirection: 'column', flex: 1, gap },
        children: safeItems.map((item, i) => numberedRow(theme, { ...item, index: i })),
      },
    });

  } else if (type === 'metric') {
    const item = safeItems[0] || { value: '---', label: '' };
    children.push({
      type: 'div',
      props: {
        style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1 },
        children: [metricCard(theme, item)],
      },
    });

  } else if (type === 'quote') {
    const item = safeItems[0] || { quote: '' };
    children.push({
      type: 'div',
      props: {
        style: { display: 'flex', flexDirection: 'column', justifyContent: 'center', flex: 1, padding: '0 32px' },
        children: [quoteBlock(theme, item)],
      },
    });

  } else if (type === 'two-column') {
    const left = safeItems.filter((_, i) => i % 2 === 0);
    const right = safeItems.filter((_, i) => i % 2 === 1);
    const colGap = Math.max(left.length, right.length) <= 3 ? 28 : 18;
    children.push({
      type: 'div',
      props: {
        style: { display: 'flex', gap: 24, flex: 1 },
        children: [
          { type: 'div', props: { style: { display: 'flex', flexDirection: 'column', gap: colGap, width: '48%' }, children: left.map((item, i) => numberedRow(theme, { ...item, index: i * 2 })) } },
          { type: 'div', props: { style: { display: 'flex', flexDirection: 'column', gap: colGap, width: '48%' }, children: right.map((item, i) => numberedRow(theme, { ...item, index: i * 2 + 1 })) } },
        ],
      },
    });
  }

  const footer = showBrandFooter ? brandFooter(theme) : null;
  if (footer) children.push(footer);
  children.push(accentLine(theme));

  return {
    type: 'div',
    props: {
      style: {
        width: W_SQUARE,
        height: H_SQUARE,
        display: 'flex',
        flexDirection: 'column',
        padding: '44px 44px 32px',
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

async function renderToBuffer(element, fonts, width = W_SQUARE, height = H_SQUARE) {
  const svg = await satori(element, { width, height, fonts });
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function renderLayout(brand, layout, variant = 'dark') {
  const theme = buildTheme(brand, variant);
  const fonts = await resolveFonts(brand);
  const element = buildLayout(theme, layout);
  return renderToBuffer(element, fonts);
}

async function renderCustomElement(brand, element, variant = 'dark', width = W_SQUARE, height = H_SQUARE) {
  const fonts = await resolveFonts(brand);
  return renderToBuffer(element, fonts, width, height);
}

module.exports = {
  renderLayout,
  renderCustomElement,
  renderToBuffer,
  resolveFonts,
  buildTheme,
  buildLayout,
  COMPONENT_MAP,
  W_SQUARE,
  H_SQUARE,
  W_PORTRAIT,
  H_PORTRAIT,
};

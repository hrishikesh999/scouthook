'use strict';

const FALLBACK_FONT = "system-ui,-apple-system,'Helvetica Neue',sans-serif";
const PATTERN_COLOR = 'rgba(255,255,255,0.12)';

const fontCache = new Map();

function angleToGradientCoords(angleDeg) {
  const rad = ((angleDeg || 135) - 90) * Math.PI / 180;
  const x2 = Math.round((Math.cos(rad) + 1) / 2 * 1000) / 1000;
  const y2 = Math.round((Math.sin(rad) + 1) / 2 * 1000) / 1000;
  return { x1: 1 - x2, y1: 1 - y2, x2, y2 };
}

function buildSvgPatternDef(patternKey) {
  const c = PATTERN_COLOR;
  switch (patternKey) {
    case 'dots':
      return `<pattern id="bgPat" width="14" height="14" patternUnits="userSpaceOnUse">
      <circle cx="7" cy="7" r="1.5" fill="${c}"/></pattern>`;
    case 'grid':
      return `<pattern id="bgPat" width="24" height="24" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="24" y2="0" stroke="${c}" stroke-width="1"/>
      <line x1="0" y1="0" x2="0" y2="24" stroke="${c}" stroke-width="1"/></pattern>`;
    case 'lines':
      return `<pattern id="bgPat" width="1" height="11" patternUnits="userSpaceOnUse">
      <rect y="10" width="1" height="1" fill="${c}"/></pattern>`;
    case 'diagonal':
      return `<pattern id="bgPat" width="11" height="11" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect y="10" width="11" height="1" fill="${c}"/></pattern>`;
    case 'diamond':
      return `<pattern id="bgPat" width="20" height="20" patternUnits="userSpaceOnUse">
      <line x1="0" y1="10" x2="10" y2="0" stroke="${c}" stroke-width="1"/>
      <line x1="10" y1="0" x2="20" y2="10" stroke="${c}" stroke-width="1"/>
      <line x1="20" y1="10" x2="10" y2="20" stroke="${c}" stroke-width="1"/>
      <line x1="10" y1="20" x2="0" y2="10" stroke="${c}" stroke-width="1"/></pattern>`;
    case 'chevron':
      return `<pattern id="bgPat" width="14" height="14" patternUnits="userSpaceOnUse">
      <line x1="0" y1="7" x2="7" y2="0" stroke="${c}" stroke-width="1"/>
      <line x1="7" y1="0" x2="14" y2="7" stroke="${c}" stroke-width="1"/>
      <line x1="0" y1="14" x2="7" y2="7" stroke="${c}" stroke-width="1"/>
      <line x1="7" y1="7" x2="14" y2="14" stroke="${c}" stroke-width="1"/></pattern>`;
    case 'stripe':
      return `<pattern id="bgPat" width="12" height="1" patternUnits="userSpaceOnUse">
      <rect x="0" y="0" width="1" height="1" fill="${c}"/></pattern>`;
    case 'noise':
      return `<pattern id="bgPat" width="7" height="7" patternUnits="userSpaceOnUse">
      <circle cx="3.5" cy="3.5" r="1" fill="${c}"/></pattern>`;
    default:
      return `<pattern id="bgPat" width="14" height="14" patternUnits="userSpaceOnUse">
      <circle cx="7" cy="7" r="1.5" fill="${c}"/></pattern>`;
  }
}

function buildBackgroundSvg(brand, W, H) {
  const bg = brand.bg || '#0F1A3C';
  const bgType = brand.bg_type || 'solid';

  if (bgType === 'gradient' && brand.bg_gradient) {
    const g = brand.bg_gradient;
    const { x1, y1, x2, y2 } = angleToGradientCoords(g.angle);
    return {
      defs: `<linearGradient id="bgGrad" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
      <stop offset="0%" stop-color="${g.from || bg}"/>
      <stop offset="100%" stop-color="${g.to || bg}"/></linearGradient>`,
      rects: `<rect width="${W}" height="${H}" fill="url(#bgGrad)"/>`,
    };
  }

  if (bgType === 'pattern' && brand.bg_pattern) {
    const patDef = buildSvgPatternDef(brand.bg_pattern);
    return {
      defs: patDef,
      rects: `<rect width="${W}" height="${H}" fill="${bg}"/>\n  <rect width="${W}" height="${H}" fill="url(#bgPat)"/>`,
    };
  }

  if (bgType === 'image' && brand.bg_image) {
    return {
      defs: '',
      rects: `<image href="${brand.bg_image}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`,
    };
  }

  return {
    defs: '',
    rects: `<rect width="${W}" height="${H}" fill="${bg}"/>`,
  };
}

function buildFontFamily(brandFont, fallback) {
  if (!brandFont) return fallback || FALLBACK_FONT;
  return `'${brandFont}',${fallback || FALLBACK_FONT}`;
}

async function fetchFontFaceBlock(fontHeading, fontBody) {
  const fonts = new Set();
  if (fontHeading) fonts.add(fontHeading);
  if (fontBody) fonts.add(fontBody);
  if (fonts.size === 0) return '';

  const blocks = [];
  for (const fontName of fonts) {
    for (const weight of [400, 500, 600, 700]) {
      const cacheKey = `${fontName}:${weight}`;
      if (fontCache.has(cacheKey)) {
        const cached = fontCache.get(cacheKey);
        if (cached) blocks.push(cached);
        continue;
      }
      try {
        const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@${weight}&display=swap`;
        const cssRes = await fetch(cssUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        });
        if (!cssRes.ok) { fontCache.set(cacheKey, null); continue; }
        const css = await cssRes.text();

        const urlMatch = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/);
        if (!urlMatch) { fontCache.set(cacheKey, null); continue; }

        const fontRes = await fetch(urlMatch[1]);
        if (!fontRes.ok) { fontCache.set(cacheKey, null); continue; }
        const fontBuf = Buffer.from(await fontRes.arrayBuffer());
        const b64 = fontBuf.toString('base64');

        const block = `@font-face { font-family: '${fontName}'; font-weight: ${weight}; src: url('data:font/woff2;base64,${b64}') format('woff2'); }`;
        fontCache.set(cacheKey, block);
        blocks.push(block);
      } catch (err) {
        console.warn(`[svgBrandBg] font fetch failed for ${fontName}:${weight}:`, err.message);
        fontCache.set(cacheKey, null);
      }
    }
  }

  if (blocks.length === 0) return '';
  return `<style>${blocks.join('\n')}</style>`;
}

module.exports = { buildBackgroundSvg, buildFontFamily, fetchFontFaceBlock, FALLBACK_FONT };

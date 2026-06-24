'use strict';

const satori = require('satori').default;
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const W = 1080;
const H = 1080;

const BRAND = {
  bg: '#0F1A3C',
  accent: '#0D7A5F',
  text: '#F0F4FF',
  textMuted: '#8A9CC0',
  cardBg: 'rgba(255,255,255,0.06)',
  name: 'ScoutHook',
};

const ITEMS = [
  { num: '1', title: 'Content calendar', body: 'Plan a month of posts in 10 minutes. No more blank page anxiety.' },
  { num: '2', title: 'Hook generator', body: 'Get 5 scroll-stopping openers for any topic. Pick the one that hits.' },
  { num: '3', title: 'Carousel builder', body: 'Turn one idea into 7 polished slides. Ready to upload to LinkedIn.' },
  { num: '4', title: 'Comment strategy', body: 'Draft thoughtful replies that build relationships, not just visibility.' },
  { num: '5', title: 'Analytics review', body: 'Identify what worked this week. Double down on what resonates.' },
  { num: '6', title: 'Voice matching', body: 'Write in your exact tone. No more generic AI-sounding content.' },
];

function iconCircle(color) {
  return {
    type: 'div',
    props: {
      style: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: color,
        opacity: 0.2,
        flexShrink: 0,
      },
    },
  };
}

function card(item, accentColor) {
  return {
    type: 'div',
    props: {
      style: {
        width: '46%',
        backgroundColor: BRAND.cardBg,
        borderRadius: 16,
        padding: '24px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', alignItems: 'center', gap: 12 },
            children: [
              iconCircle(accentColor),
              {
                type: 'span',
                props: {
                  style: {
                    fontSize: 28,
                    fontWeight: 700,
                    color: BRAND.text,
                  },
                  children: item.title,
                },
              },
            ],
          },
        },
        {
          type: 'p',
          props: {
            style: {
              fontSize: 20,
              color: BRAND.textMuted,
              lineHeight: 1.5,
              margin: 0,
            },
            children: item.body,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 4,
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    backgroundColor: accentColor,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 13,
                    fontWeight: 700,
                    color: '#fff',
                  },
                  children: item.num,
                },
              },
            ],
          },
        },
      ],
    },
  };
}

const element = {
  type: 'div',
  props: {
    style: {
      width: W,
      height: H,
      display: 'flex',
      flexDirection: 'column',
      padding: '48px 40px',
      backgroundImage: 'linear-gradient(155deg, #0a0f1e 0%, #111d3a 40%, #0d2847 100%)',
      fontFamily: 'Inter',
      position: 'relative',
    },
    children: [
      {
        type: 'div',
        props: {
          style: {
            position: 'absolute',
            top: -60,
            right: -60,
            width: 220,
            height: 220,
            borderRadius: 110,
            border: '1px solid rgba(13,122,95,0.15)',
          },
        },
      },
      {
        type: 'div',
        props: {
          style: {
            position: 'absolute',
            bottom: 80,
            left: -40,
            width: 160,
            height: 160,
            borderRadius: 80,
            border: '1px solid rgba(13,122,95,0.08)',
          },
        },
      },
      {
        type: 'div',
        props: {
          style: { width: 40, height: 4, backgroundColor: BRAND.accent, borderRadius: 2, marginBottom: 16 },
        },
      },
      {
        type: 'span',
        props: {
          style: {
            fontSize: 14,
            letterSpacing: 3,
            color: BRAND.accent,
            textTransform: 'uppercase',
            marginBottom: 8,
          },
          children: 'LinkedIn Growth',
        },
      },
      {
        type: 'h1',
        props: {
          style: {
            fontSize: 48,
            fontWeight: 700,
            color: BRAND.text,
            lineHeight: 1.15,
            letterSpacing: -1,
            margin: 0,
            marginBottom: 8,
          },
          children: '6 ways to use AI for LinkedIn growth',
        },
      },
      {
        type: 'div',
        props: {
          style: { width: 32, height: 2, backgroundColor: BRAND.accent, borderRadius: 1, marginBottom: 6 },
        },
      },
      {
        type: 'span',
        props: {
          style: { fontSize: 18, color: BRAND.textMuted, marginBottom: 32 },
          children: 'Save this for later — you\'ll need it.',
        },
      },
      {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            gap: 20,
            justifyContent: 'center',
            flex: 1,
          },
          children: ITEMS.map(item => card(item, BRAND.accent)),
        },
      },
      {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            justifyContent: 'center',
            marginTop: 16,
          },
          children: [
            {
              type: 'span',
              props: {
                style: { fontSize: 16, color: BRAND.textMuted, opacity: 0.5, letterSpacing: 1 },
                children: BRAND.name,
              },
            },
          ],
        },
      },
      {
        type: 'div',
        props: {
          style: {
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: W,
            height: 3,
            backgroundImage: 'linear-gradient(90deg, #0D7A5F, transparent)',
          },
        },
      },
    ],
  },
};

async function main() {
  console.time('total');

  console.time('font-load');
  const fontUrl = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
  const cssRes = await fetch(fontUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  const css = await cssRes.text();

  const ttfMatches = [...css.matchAll(/src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)];
  const fontBuffers = [];
  for (const match of ttfMatches.slice(0, 2)) {
    const res = await fetch(match[1]);
    fontBuffers.push(Buffer.from(await res.arrayBuffer()));
  }
  console.timeEnd('font-load');

  if (fontBuffers.length === 0) {
    console.error('No fonts loaded — using fallback');
    const fallbackRes = await fetch('https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-400-normal.ttf');
    fontBuffers.push(Buffer.from(await fallbackRes.arrayBuffer()));
  }

  const fonts = fontBuffers.map((data, i) => ({
    name: 'Inter',
    data,
    weight: i === 0 ? 400 : 700,
    style: 'normal',
  }));

  console.time('satori');
  const svg = await satori(element, { width: W, height: H, fonts });
  console.timeEnd('satori');

  console.time('sharp-png');
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  console.timeEnd('sharp-png');

  const outDir = path.join(__dirname, '..', 'generated');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'satori-poc.png');
  fs.writeFileSync(outPath, pngBuffer);

  console.timeEnd('total');
  console.log(`Output: ${outPath} (${(pngBuffer.length / 1024).toFixed(0)}KB)`);
}

main().catch(console.error);

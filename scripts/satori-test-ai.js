'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { validateLayout } = require('../services/infographicGenerator');
const { renderLayout } = require('../services/satoriRenderer');
const storage = require('../services/storage');
const { extractJsonFromResponse, getAnthropicMessageText } = require('../services/voiceFingerprint');
const fs = require('fs');
const path = require('path');

const BRAND = {
  bg: '#0F1A3C',
  accent: '#0D7A5F',
  text: '#F0F4FF',
  name: 'ScoutHook',
  font_heading: 'Inter',
  font_body: 'Inter',
  secondary_text: '#8A9CC0',
  bg_type: 'solid',
};

const EXTRACT_PROMPT = `Analyze this LinkedIn post and create an infographic layout. Return ONLY valid JSON matching one of these formats:

FORMAT 1 — card-grid (best for posts listing tips, tools, strategies, or features):
{ "type": "card-grid", "columns": 2, "tag": "SHORT CATEGORY", "title": "Headline (max 10 words)", "subtitle": "One-line teaser (optional)", "items": [{ "title": "Card title (2-4 words)", "body": "1-2 sentences." }, ...] }

FORMAT 2 — numbered-list (best for step-by-step posts, habits, mistakes, rules):
{ "type": "numbered-list", "tag": "SHORT CATEGORY", "title": "Headline (max 10 words)", "items": [{ "title": "Step name (2-5 words)", "body": "1 sentence." }, ...] }

FORMAT 3 — metric (best for posts about results, revenue, growth numbers):
{ "type": "metric", "title": "Context (max 6 words)", "items": [{ "value": "THE BIG NUMBER", "label": "What it means", "context": "WHO (2-4 words)" }] }

FORMAT 4 — quote (best for testimonials, client feedback):
{ "type": "quote", "title": "Context (max 4 words)", "items": [{ "quote": "The quote (1-3 sentences)", "attribution": "Name, Role" }] }

FORMAT 5 — two-column (best for comparison, before/after, input/output):
{ "type": "two-column", "tag": "SHORT CATEGORY", "title": "Headline (max 10 words)", "items": [{ "title": "Left 1", "body": "..." }, { "title": "Right 1", "body": "..." }, ...] }

Rules:
- Pick the ONE best format. metric value: plain ASCII only (no currency symbols, no arrows).
- All text concise. Do NOT wrap in markdown code fences.

POST:
`;

const SAMPLE_POSTS = [
  {
    id: 'test-tips',
    content: `I make $450K/month with 7 people.\n\n(83.1% profit margin, no paid ads)\n\nHere's exactly how I built it:\n\n1. Started with one course on a topic I knew deeply\n2. Built an email list of 50K by giving away free frameworks\n3. Created a team of 7 specialists (not generalists)\n4. Automated everything that didn't need a human touch\n5. Focused on one platform (YouTube) instead of being everywhere\n6. Priced premium from day one — no race to the bottom\n\nThe boring truth? Consistency beats creativity every time.`,
  },
  {
    id: 'test-result',
    content: `My client Sarah just hit a milestone.\n\nWhen we started working together 90 days ago, she was making 3 lakhs per month from her coaching business.\n\nYesterday she crossed 18 lakhs.\n\nThat's a 6x increase in 90 days.\n\nHere's what changed: we rebuilt her offer, fixed her funnel, and focused all her content on one specific ICP.\n\nNo paid ads. No viral hacks. Just clarity and consistency.`,
  },
  {
    id: 'test-quote',
    content: `"Working with this coaching program changed everything for my business. I went from posting randomly on LinkedIn to having a system that generates 15-20 inbound leads per week. The ROI paid for itself in the first month."\n\n— Priya Sharma, Founder at GrowthLab Consulting\n\nThis is what happens when you stop guessing and start following a proven system.`,
  },
];

async function main() {
  const outDir = path.join(__dirname, '..', 'generated');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Try to get API key from env or fall back to hardcoded test layouts
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

  if (!apiKey) {
    console.log('No ANTHROPIC_API_KEY — testing with hardcoded AI responses.\n');
    await testWithHardcodedLayouts(outDir);
    return;
  }

  const client = new Anthropic({ apiKey });

  for (const post of SAMPLE_POSTS) {
    console.log(`\n--- Processing: ${post.id} ---`);

    console.time(`extract-${post.id}`);
    let layout;
    try {
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: EXTRACT_PROMPT + post.content }],
      });
      const rawText = getAnthropicMessageText(msg);
      layout = validateLayout(extractJsonFromResponse(rawText));
    } catch (err) {
      console.error(`  Extract failed: ${err.message}`);
      continue;
    }
    console.timeEnd(`extract-${post.id}`);
    console.log(`  Layout type: ${layout.type}`);
    console.log(`  Title: ${layout.title}`);
    console.log(`  Items: ${layout.items?.length || 0}`);
    console.log(`  JSON: ${JSON.stringify(layout, null, 2)}`);

    for (const variant of ['dark', 'light']) {
      console.time(`render-${post.id}-${variant}`);
      const pngBuffer = await renderLayout(BRAND, layout, variant);
      const outPath = path.join(outDir, `ai-${post.id}-${variant}.png`);
      fs.writeFileSync(outPath, pngBuffer);
      console.timeEnd(`render-${post.id}-${variant}`);
      console.log(`  → ${outPath} (${(pngBuffer.length / 1024).toFixed(0)}KB)`);
    }
  }

  console.log('\nAll AI-generated infographics rendered.');
}

async function testWithHardcodedLayouts(outDir) {
  const hardcoded = [
    {
      id: 'hardcoded-tips',
      layout: {
        type: 'numbered-list',
        tag: 'ONLINE BUSINESS',
        title: 'How I built a $450K/month business with 7 people',
        items: [
          { title: 'One course, one topic', body: 'Started with a single course on a subject I knew deeply.' },
          { title: '50K email list', body: 'Gave away free frameworks to build the list organically.' },
          { title: '7 specialists, not generalists', body: 'Every hire was a domain expert, not a jack of all trades.' },
          { title: 'Automate the boring stuff', body: 'If it doesn\'t need a human, a machine handles it.' },
          { title: 'One platform only', body: 'YouTube. Not TikTok, not Instagram. Just one.' },
          { title: 'Premium pricing from day one', body: 'No race to the bottom. Value-based pricing only.' },
        ],
      },
    },
    {
      id: 'hardcoded-metric',
      layout: {
        type: 'metric',
        title: 'Client result',
        items: [{ value: '6x revenue', label: 'Growth in 90 days', context: 'Coaching Business' }],
      },
    },
    {
      id: 'hardcoded-quote',
      layout: {
        type: 'quote',
        title: 'Client testimonial',
        items: [{ quote: 'I went from posting randomly on LinkedIn to having a system that generates 15-20 inbound leads per week. The ROI paid for itself in the first month.', attribution: 'Priya Sharma, Founder at GrowthLab Consulting' }],
      },
    },
  ];

  for (const { id, layout } of hardcoded) {
    for (const variant of ['dark', 'light']) {
      console.time(`${id}-${variant}`);
      const pngBuffer = await renderLayout(BRAND, layout, variant);
      const outPath = path.join(outDir, `ai-${id}-${variant}.png`);
      fs.writeFileSync(outPath, pngBuffer);
      console.timeEnd(`${id}-${variant}`);
      console.log(`  → ${outPath} (${(pngBuffer.length / 1024).toFixed(0)}KB)`);
    }
  }
  console.log('\nHardcoded layout test complete. Set ANTHROPIC_API_KEY to test with real AI extraction.');
}

main().catch(console.error);

'use strict';

const { renderLayout } = require('../services/satoriRenderer');
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

const LAYOUTS = [
  {
    name: 'card-grid-dark',
    variant: 'dark',
    layout: {
      type: 'card-grid',
      columns: 2,
      tag: 'LinkedIn Growth',
      title: '6 ways to use AI for LinkedIn growth',
      subtitle: 'Save this for later — you\'ll need it.',
      items: [
        { title: 'Content calendar', body: 'Plan a month of posts in 10 minutes. No more blank page anxiety.' },
        { title: 'Hook generator', body: 'Get 5 scroll-stopping openers for any topic. Pick the one that hits.' },
        { title: 'Carousel builder', body: 'Turn one idea into 7 polished slides. Ready to upload to LinkedIn.' },
        { title: 'Comment strategy', body: 'Draft thoughtful replies that build relationships, not just visibility.' },
        { title: 'Analytics review', body: 'Identify what worked this week. Double down on what resonates.' },
        { title: 'Voice matching', body: 'Write in your exact tone. No more generic AI-sounding content.' },
      ],
    },
  },
  {
    name: 'card-grid-light',
    variant: 'light',
    layout: {
      type: 'card-grid',
      columns: 2,
      tag: 'Coaching Playbook',
      title: '4 ways to close high-ticket clients',
      items: [
        { title: 'Discovery call', body: 'Ask the right questions. Let them sell themselves on working with you.' },
        { title: 'Case study proof', body: 'Show one client result that mirrors their situation exactly.' },
        { title: 'Proposal clarity', body: 'One page. Three options. No confusion about what they get.' },
        { title: 'Follow-up system', body: 'The fortune is in the follow-up. Automate the first three touches.' },
      ],
    },
  },
  {
    name: 'numbered-list-dark',
    variant: 'dark',
    layout: {
      type: 'numbered-list',
      tag: 'Personal Brand',
      title: '8 bad habits that block your LinkedIn growth',
      items: [
        { title: 'Posting without a strategy', body: 'Random content confuses your audience. Pick 3 pillars and stick to them.' },
        { title: 'Ignoring comments', body: 'Every comment is a relationship. Reply within 2 hours or lose the momentum.' },
        { title: 'Writing for everyone', body: 'If you write for everyone, you write for no one. Niche down.' },
        { title: 'No clear CTA', body: 'Every post should give the reader one clear next step.' },
        { title: 'Inconsistent posting', body: '3x per week minimum. The algorithm rewards consistency over virality.' },
      ],
    },
  },
  {
    name: 'metric-accent',
    variant: 'accent',
    layout: {
      type: 'metric',
      title: 'Client result',
      items: [{ value: '3L to 18L', label: 'Revenue growth in 90 days', context: 'SaaS Founder - B2B Segment' }],
    },
  },
  {
    name: 'two-column-dark',
    variant: 'dark',
    layout: {
      type: 'two-column',
      tag: 'Framework',
      title: 'The inputs and outputs of a content system',
      items: [
        { title: 'Build voice project', body: 'Open Claude, create a project named after yourself.' },
        { title: 'Second brain you own', body: 'Everything in one place. No more digging through old threads.' },
        { title: 'Upload everything', body: 'Newsletters, posts, transcripts, decks — drop it all in.' },
        { title: 'Output that sounds like you', body: 'Your phrases, your rhythm, your edge, baked into every response.' },
        { title: 'Write a tone doc', body: 'One file with voice rules, banned phrases, sentence patterns.' },
        { title: 'No more brief writing', body: 'The voice doc does the briefing so you can skip the setup.' },
      ],
    },
  },
  {
    name: 'quote-light',
    variant: 'light',
    layout: {
      type: 'quote',
      title: 'Client testimonial',
      items: [{ quote: 'Working with this team transformed our entire LinkedIn strategy. We went from 200 to 5,000 followers in 90 days.', attribution: 'Sarah Chen, CEO at GrowthLab' }],
    },
  },
];

async function main() {
  const outDir = path.join(__dirname, '..', 'generated');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  for (const { name, variant, layout } of LAYOUTS) {
    console.time(name);
    const buf = await renderLayout(BRAND, layout, variant);
    const outPath = path.join(outDir, `satori-${name}.png`);
    fs.writeFileSync(outPath, buf);
    console.timeEnd(name);
    console.log(`  → ${outPath} (${(buf.length / 1024).toFixed(0)}KB)`);
  }

  console.log('\nAll layouts rendered successfully.');
}

main().catch(console.error);

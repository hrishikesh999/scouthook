'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting } = require('../db');
const storage = require('./storage');
const { getAnthropicMessageText } = require('./voiceFingerprint');

async function getPlacidConfig() {
  const apiKey = (process.env.PLACID_API_KEY || '').trim() || (await getSetting('placid_api_key'));
  if (!apiKey) throw new Error('placid_api_key not configured');
  const templateId = (process.env.PLACID_TEMPLATE_ID || '').trim() || (await getSetting('placid_template_id'));
  if (!templateId) throw new Error('placid_template_id not configured');
  return { apiKey, templateId };
}

async function extractPlacidContent(post) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `From this LinkedIn post, extract two things and return ONLY valid JSON with no extra text:
1. "headline": The sharpest, most striking line from the post. Maximum 10 words. Must work standalone out of context.
2. "subtext": A supporting sentence or the key takeaway. Maximum 20 words.

Post:
${post.content}

Return only: {"headline":"...","subtext":"..."}`,
    }],
  });
  const raw = getAnthropicMessageText(msg) || '{}';
  try {
    const parsed = JSON.parse(raw);
    return {
      headline: parsed.headline || post.content.split('\n')[0].slice(0, 80),
      subtext: parsed.subtext || '',
    };
  } catch {
    return {
      headline: post.content.split('\n')[0].slice(0, 80),
      subtext: '',
    };
  }
}

async function renderPlacidImage(post, content, ctx = {}) {
  const { userId, tenantId } = ctx;
  const { apiKey, templateId } = await getPlacidConfig();

  const headlineLayer = (process.env.PLACID_LAYER_HEADLINE || 'headline').trim();
  const subtextLayer  = (process.env.PLACID_LAYER_SUBTEXT  || 'subtext').trim();

  const layers = {};
  if (content.headline) layers[headlineLayer] = { text: content.headline };
  if (content.subtext)  layers[subtextLayer]  = { text: content.subtext };

  // Create the image
  const createRes = await fetch('https://api.placid.app/api/rest/images', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ template_uuid: templateId, layers }),
  });

  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Placid create failed (${createRes.status}): ${body}`);
  }

  let job = await createRes.json();

  // Poll until finished (250 ms intervals, 30 s timeout)
  const deadline = Date.now() + 30_000;
  while (job.status !== 'finished' && job.status !== 'error') {
    if (Date.now() > deadline) throw new Error('Placid image generation timed out');
    await new Promise(r => setTimeout(r, 250));
    const pollRes = await fetch(`https://api.placid.app/api/rest/images/${job.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!pollRes.ok) throw new Error(`Placid poll failed (${pollRes.status})`);
    job = await pollRes.json();
  }

  if (job.status === 'error') throw new Error('Placid reported an error generating the image');

  // Download and store the result
  const imgRes = await fetch(job.image_url);
  if (!imgRes.ok) throw new Error(`Failed to download Placid image (${imgRes.status})`);
  const buf = Buffer.from(await imgRes.arrayBuffer());

  const filename = `ai_image_${post.id}_${Date.now()}.png`;
  await storage.upload(buf, { tenantId, userId, type: 'generated', filename, mimeType: 'image/png' });

  return { png_url: `/files/${filename}` };
}

async function generatePlacidImage(post, ctx = {}) {
  const content = await extractPlacidContent(post);
  return renderPlacidImage(post, content, ctx);
}

module.exports = { generatePlacidImage, extractPlacidContent, renderPlacidImage };

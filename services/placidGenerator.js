'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSetting, db } = require('../db');
const storage = require('./storage');
const { getAnthropicMessageText } = require('./voiceFingerprint');

function parseTextLayers(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Resolve Placid config: specific template by id → global default → env vars
async function getPlacidConfig(templateId) {
  const apiKey = (process.env.PLACID_API_KEY || '').trim() || (await getSetting('placid_api_key'));
  if (!apiKey) throw new Error('placid_api_key not configured');

  if (templateId) {
    const row = await db.prepare(
      'SELECT template_uuid, layer_headline, layer_subtext, custom_layers FROM placid_templates WHERE id = ?'
    ).get(templateId);
    if (row) return {
      apiKey,
      templateUuid:  row.template_uuid,
      headlineLayer: row.layer_headline,
      subtextLayer:  row.layer_subtext,
      textLayers:    parseTextLayers(row.custom_layers),
    };
  }

  const def = await db.prepare(
    'SELECT template_uuid, layer_headline, layer_subtext, custom_layers FROM placid_templates WHERE is_default = TRUE LIMIT 1'
  ).get();
  if (def) return {
    apiKey,
    templateUuid:  def.template_uuid,
    headlineLayer: def.layer_headline,
    subtextLayer:  def.layer_subtext,
    textLayers:    parseTextLayers(def.custom_layers),
  };

  // Fallback: env / platform settings
  const templateUuid = (process.env.PLACID_TEMPLATE_ID || '').trim() || (await getSetting('placid_template_id'));
  if (!templateUuid) throw new Error('No Placid template configured. Add one in Admin → Placid Templates or set PLACID_TEMPLATE_ID.');
  return { apiKey, templateUuid, headlineLayer: 'headline', subtextLayer: 'subtext', textLayers: [] };
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
    return { headline: post.content.split('\n')[0].slice(0, 80), subtext: '' };
  }
}

async function renderPlacidImage(post, content, ctx = {}, templateId = null) {
  const { userId, tenantId } = ctx;
  const { apiKey, templateUuid, headlineLayer, subtextLayer, textLayers } = await getPlacidConfig(templateId);

  const layers = {};
  if (content.headline) layers[headlineLayer] = { text: content.headline };
  if (content.subtext)  layers[subtextLayer]  = { text: content.subtext };
  if (content.extra_fields && textLayers.length > 0) {
    for (const tl of textLayers) {
      const val = content.extra_fields[tl.layer_name];
      if (val) layers[tl.layer_name] = { text: val };
    }
  }

  const createRes = await fetch('https://api.placid.app/api/rest/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ template_uuid: templateUuid, layers }),
  });

  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Placid create failed (${createRes.status}): ${body}`);
  }

  let job = await createRes.json();

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

  const imgRes = await fetch(job.image_url);
  if (!imgRes.ok) throw new Error(`Failed to download Placid image (${imgRes.status})`);
  const buf = Buffer.from(await imgRes.arrayBuffer());

  const filename = `ai_image_${post.id}_${Date.now()}.png`;
  await storage.upload(buf, { tenantId, userId, type: 'generated', filename, mimeType: 'image/png' });

  return { png_url: `/files/${filename}` };
}

async function generatePlacidImage(post, ctx = {}, templateId = null) {
  const content = await extractPlacidContent(post);
  return renderPlacidImage(post, content, ctx, templateId);
}

module.exports = { generatePlacidImage, extractPlacidContent, renderPlacidImage };

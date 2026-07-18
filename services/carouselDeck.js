'use strict';

// Carousel deck drafts — the editable document behind the Carousel Studio.
//
// A deck is a single JSON document (carousel_drafts.deck, migration 075):
//   {
//     version: 1,
//     pack_id: '<uuid>',
//     settings: {
//       aspect: 'square' | 'portrait',
//       theme: { colors: { canonicalName: '#hex' }, fontScale: 1 },
//       decorations: { pageNumbers, swipeCue, byline: { enabled, name } }
//     },
//     slides: [
//       { id, template_id, role: 'title'|'content'|'closing',
//         locked: false, slots: { canonicalSlotName: 'text' } }
//     ]
//   }
//
// Slide `slots` use CANONICAL names (pack.variable_map.slots keys) so content
// survives template/variant switches; mapping to template-specific slot names
// happens at render time (mapContentToSlots).

const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { db, getSetting } = require('../db');
const { extractJsonFromResponse, getAnthropicMessageText } = require('./voiceFingerprint');

const DECK_VERSION = 1;
const VALID_ROLES = new Set(['title', 'content', 'closing']);
const MAX_SLIDES = 20;
const MAX_SLOT_LENGTH = 600;
const HEX_RE = /^#[0-9a-f]{6}$/i;

// ---------------------------------------------------------------------------
// Build a fresh deck from an AI extraction result
// ---------------------------------------------------------------------------

function buildDeckFromExtract(pack, slides, extracted) {
  const titleTpl = slides.find(s => s.role === 'title') || null;
  const contentTpls = slides.filter(s => s.role === 'content');
  const closingTpl = slides.find(s => s.role === 'closing') || null;

  const deckSlides = [];

  if (titleTpl && extracted.title) {
    deckSlides.push({
      id: crypto.randomUUID(),
      template_id: titleTpl.template_id,
      role: 'title',
      locked: false,
      slots: sanitizeSlots(extracted.title),
    });
  }

  const contentData = extracted.content_slides || [];
  for (let i = 0; i < contentData.length; i++) {
    const tpl = contentTpls[i % contentTpls.length] || contentTpls[0];
    if (!tpl) break;
    deckSlides.push({
      id: crypto.randomUUID(),
      template_id: tpl.template_id,
      role: 'content',
      locked: false,
      slots: sanitizeSlots(contentData[i]),
    });
  }

  if (closingTpl && extracted.closing) {
    deckSlides.push({
      id: crypto.randomUUID(),
      template_id: closingTpl.template_id,
      role: 'closing',
      locked: false,
      slots: sanitizeSlots(extracted.closing),
    });
  }

  const deck = {
    version: DECK_VERSION,
    pack_id: pack.id,
    settings: {
      aspect: pack.aspect_ratio === 'portrait' ? 'portrait' : 'square',
      theme: { colors: {}, fontScale: 1 },
      decorations: {
        pageNumbers: true,
        swipeCue: true,
        byline: { enabled: false, name: '' },
      },
    },
    slides: deckSlides,
  };

  // Cover options from the swipe-native planner — surfaced as a picker on
  // the title slide in the Studio.
  if (Array.isArray(extracted.title_options) && extracted.title_options.length > 1) {
    deck.meta = { title_options: extracted.title_options.slice(0, 3).map(sanitizeSlots) };
  }

  return deck;
}

function sanitizeSlots(slots) {
  const out = {};
  if (!slots || typeof slots !== 'object') return out;
  for (const [key, value] of Object.entries(slots)) {
    if (typeof key !== 'string' || key.length > 100) continue;
    if (typeof value === 'string') {
      out[key] = value.slice(0, MAX_SLOT_LENGTH);
    } else if (Array.isArray(value)) {
      // repeating slots (lists) — array of short strings
      out[key] = value.filter(v => typeof v === 'string').map(v => v.slice(0, MAX_SLOT_LENGTH)).slice(0, 20);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation — throws { status, message } on structural problems, silently
// sanitizes value-level ones (lengths, bad hex, unknown keys).
// ---------------------------------------------------------------------------

function validateDeck(deck, pack, slides) {
  const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };

  if (!deck || typeof deck !== 'object') fail('deck_required');
  if (deck.version !== DECK_VERSION) fail('unsupported_deck_version');
  if (deck.pack_id !== pack.id) fail('deck_pack_mismatch');
  if (!Array.isArray(deck.slides) || deck.slides.length < 2) fail('deck_needs_at_least_2_slides');
  if (deck.slides.length > MAX_SLIDES) fail(`deck_exceeds_${MAX_SLIDES}_slides`);

  const templatesById = new Map(slides.map(s => [s.template_id, s]));

  const cleanSlides = deck.slides.map(slide => {
    if (!slide || typeof slide !== 'object') fail('invalid_slide');
    if (!VALID_ROLES.has(slide.role)) fail('invalid_slide_role');
    const tpl = templatesById.get(slide.template_id);
    if (!tpl) fail('slide_template_not_in_pack');
    if (tpl.role !== slide.role) fail('slide_role_template_mismatch');
    return {
      id: (typeof slide.id === 'string' && slide.id.length <= 64) ? slide.id : crypto.randomUUID(),
      template_id: slide.template_id,
      role: slide.role,
      locked: !!slide.locked,
      slots: sanitizeSlots(slide.slots),
    };
  });

  // Structural conventions: at most one title (first), at most one closing (last)
  const titleCount = cleanSlides.filter(s => s.role === 'title').length;
  const closingCount = cleanSlides.filter(s => s.role === 'closing').length;
  if (titleCount > 1 || closingCount > 1) fail('duplicate_title_or_closing');
  if (titleCount === 1 && cleanSlides[0].role !== 'title') fail('title_must_be_first');
  if (closingCount === 1 && cleanSlides[cleanSlides.length - 1].role !== 'closing') fail('closing_must_be_last');

  const s = deck.settings || {};
  const theme = s.theme || {};
  const colors = {};
  for (const [key, val] of Object.entries(theme.colors || {})) {
    if (typeof key === 'string' && key.length <= 100 && typeof val === 'string' && HEX_RE.test(val.trim())) {
      colors[key] = val.trim();
    }
  }

  const deco = s.decorations || {};
  const byline = deco.byline || {};

  // Carry planner metadata (cover options) through save round-trips
  let meta;
  if (deck.meta && Array.isArray(deck.meta.title_options) && deck.meta.title_options.length) {
    meta = { title_options: deck.meta.title_options.slice(0, 3).map(sanitizeSlots) };
  }

  return {
    ...(meta ? { meta } : {}),
    version: DECK_VERSION,
    pack_id: pack.id,
    settings: {
      aspect: s.aspect === 'portrait' ? 'portrait' : 'square',
      theme: {
        colors,
        fontScale: (typeof theme.fontScale === 'number' && theme.fontScale >= 0.5 && theme.fontScale <= 2) ? theme.fontScale : 1,
      },
      decorations: {
        pageNumbers: !!deco.pageNumbers,
        swipeCue: !!deco.swipeCue,
        byline: {
          enabled: !!byline.enabled,
          name: typeof byline.name === 'string' ? byline.name.slice(0, 80) : '',
        },
      },
    },
    slides: cleanSlides,
  };
}

// ---------------------------------------------------------------------------
// Draft CRUD
// ---------------------------------------------------------------------------

async function getDraft(postId, userId, tenantId) {
  const row = await db.prepare(
    'SELECT * FROM carousel_drafts WHERE post_id = ? AND user_id = ? AND tenant_id = ?'
  ).get(postId, userId, tenantId);
  if (!row) return null;
  const deck = typeof row.deck === 'string' ? JSON.parse(row.deck) : row.deck;
  return { id: row.id, post_id: row.post_id, deck, updated_at: row.updated_at };
}

async function upsertDraft(postId, userId, tenantId, deck) {
  await db.prepare(
    `INSERT INTO carousel_drafts (id, post_id, user_id, tenant_id, deck)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (post_id) DO UPDATE SET deck = EXCLUDED.deck, updated_at = NOW()`
  ).run(crypto.randomUUID(), postId, userId, tenantId, JSON.stringify(deck));
  return getDraft(postId, userId, tenantId);
}

async function deleteDraft(postId, userId, tenantId) {
  await db.prepare(
    'DELETE FROM carousel_drafts WHERE post_id = ? AND user_id = ? AND tenant_id = ?'
  ).run(postId, userId, tenantId);
}

// ---------------------------------------------------------------------------
// Per-slide AI rewrite (Studio "Rewrite / Shorten / Punchier" actions)
// ---------------------------------------------------------------------------

const REWRITE_ACTIONS = {
  rewrite:  'Rewrite this slide with a fresh angle while keeping the same core idea.',
  shorten:  'Cut this slide down. Fewer words, same idea. Every word must earn its place.',
  punchier: 'Make this slide punchier: stronger verbs, more concrete, more tension. No hype words.',
};

async function rewriteSlide(post, slide, action) {
  const instruction = REWRITE_ACTIONS[action];
  if (!instruction) throw Object.assign(new Error('invalid_action'), { status: 400 });

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
  if (!apiKey) throw new Error('anthropic_api_key not configured');

  const budget = slide.role === 'title'
    ? 'This is the COVER slide: headline max 8 words. It must stop the scroll.'
    : slide.role === 'closing'
      ? 'This is the CLOSING slide: a takeaway or call-to-action, max 25 words total.'
      : 'This is a CONTENT slide: one idea only, max 30 words total across all fields, written to earn the next swipe.';

  const prompt = `You are editing ONE slide of a LinkedIn carousel.

${instruction}
${budget}

Keep the author's voice — match the tone of the original post below. Return ONLY valid JSON with EXACTLY the same keys as the current slide content.

CURRENT SLIDE CONTENT:
${JSON.stringify(slide.slots)}

ORIGINAL POST (voice/context reference):
${(post.content || '').slice(0, 2000)}`;

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  let slots;
  try {
    slots = extractJsonFromResponse(getAnthropicMessageText(msg));
  } catch {
    const retry = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: msg.content },
        { role: 'user', content: 'Return only valid JSON, no other text.' },
      ],
    });
    slots = extractJsonFromResponse(getAnthropicMessageText(retry));
  }

  // Only accept keys the slide already has — the model must not invent slots
  const allowed = new Set(Object.keys(slide.slots || {}));
  const filtered = {};
  for (const [k, v] of Object.entries(sanitizeSlots(slots))) {
    if (allowed.has(k)) filtered[k] = v;
  }
  if (!Object.keys(filtered).length) throw new Error('rewrite_produced_no_usable_content');
  return filtered;
}

module.exports = {
  DECK_VERSION,
  buildDeckFromExtract,
  validateDeck,
  sanitizeSlots,
  getDraft,
  upsertDraft,
  deleteDraft,
  rewriteSlide,
};

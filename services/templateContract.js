'use strict';

// Template contract — the invariants a stored template must satisfy, plus
// slot-inventory diffing across a mutation. Pure string analysis; no I/O and
// no DB access, so it is unit-testable and safe to call from any boundary.
//
// Slot identity lives in three places (data-slot attributes, the embedded
// template-meta JSON, and the DB slot_manifest column). Nothing keeps them in
// sync by construction, so every writer that rewrites template HTML — the AI
// refine pass, the save endpoints, raw-HTML edits — must be checked here
// instead of being trusted.

const { readSlotManifest } = require('./templateSlotInjector');

// Design-system vars that appear in templates but are never color slots.
// Mirrors CSS_VAR_SKIP in public/admin-html-template-form.html — keep in sync.
const CSS_VAR_SKIP = new Set([
  'font-sans', 'font-mono', 'font-heading', 'font-body',
  'space-xs', 'space-sm', 'space-md', 'space-lg', 'space-xl',
  'radius', 'radius-sm', 'radius-md', 'radius-lg',
  'border', 'surface', 'surface-2', 'bg-surface', 'bg-subtle',
  'text-heading', 'text-secondary', 'text-muted', 'text-primary',
  'brand', 'neutral-50', 'neutral-100', 'error', 'success', 'warning',
]);

/**
 * Content slots (text / image / repeating) bound in the HTML via data-slot
 * attributes. Returns [{ key, kind }] with one entry per distinct key.
 */
function scanContentSlots(html) {
  const slots = [];
  const seen = new Set();
  for (const m of String(html).matchAll(/<[a-zA-Z][^>]*\bdata-slot="([^"]+)"[^>]*>/g)) {
    const key = m[1];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    let kind = 'text';
    if (key.startsWith('image:')) kind = 'image';
    else if (/\bdata-slot-container\b/.test(m[0])) kind = 'repeating';
    slots.push({ key, kind });
  }
  return slots;
}

/**
 * Color-slot var names referenced anywhere in the HTML via var(--x),
 * excluding design-system vars. Returns a sorted array of names
 * (without the leading -- or the color: prefix).
 */
function scanColorVars(html) {
  const vars = new Set();
  for (const m of String(html).matchAll(/var\(\s*--([a-zA-Z0-9_-]+)/g)) {
    if (!CSS_VAR_SKIP.has(m[1])) vars.add(m[1]);
  }
  return [...vars].sort();
}

/**
 * Full slot inventory of an HTML document, derived from the markup itself
 * (never from the embedded manifest — the manifest may be stale or missing).
 */
function scanSlots(html) {
  return { content: scanContentSlots(html), colors: scanColorVars(html) };
}

/**
 * Diff the slot inventories of two HTML documents (before → after a
 * mutation). Lost entries are contract violations for any mutation that
 * promises to preserve slots; added entries are generally fine.
 */
function diffSlots(beforeHtml, afterHtml) {
  const before = scanSlots(beforeHtml);
  const after = scanSlots(afterHtml);
  const afterContentKeys = new Set(after.content.map(s => s.key));
  const beforeContentKeys = new Set(before.content.map(s => s.key));
  const afterColors = new Set(after.colors);
  const beforeColors = new Set(before.colors);
  return {
    lostContent: before.content.filter(s => !afterContentKeys.has(s.key)).map(s => s.key),
    addedContent: after.content.filter(s => !beforeContentKeys.has(s.key)).map(s => s.key),
    lostColors: before.colors.filter(v => !afterColors.has(v)),
    addedColors: after.colors.filter(v => !beforeColors.has(v)),
  };
}

/**
 * Validate a template document against the contract.
 *
 * errors   — hard violations; the document must not be stored.
 * warnings — desync states worth surfacing to the admin but not blocking
 *            (they all currently exist in production templates).
 *
 * Returns { ok, errors, warnings, slots, manifest } — manifest is null when
 * the meta block is unparseable.
 */
function validate(html) {
  const errors = [];
  const warnings = [];
  let manifest = null;

  try {
    manifest = readSlotManifest(html);
  } catch (err) {
    errors.push(`template-meta is unparseable: ${err.message}`);
  }

  const slots = scanSlots(html);

  if (manifest) {
    const boundKeys = new Set(slots.content.map(s => s.key));
    const colorVarSet = new Set(slots.colors);
    const manifestKeys = Object.keys(manifest.slots || {});

    for (const key of manifestKeys) {
      if (key.startsWith('color:')) {
        if (!colorVarSet.has(key.slice('color:'.length))) {
          warnings.push(`manifest color slot "${key}" has no var(--${key.slice('color:'.length)}) usage in the HTML`);
        }
      } else if (!boundKeys.has(key)) {
        warnings.push(`manifest slot "${key}" is not bound to any element (orphaned — it will do nothing at render time)`);
      }
    }

    for (const s of slots.content) {
      if (!manifest.slots[s.key]) {
        warnings.push(`element slot "${s.key}" is missing from the manifest`);
      }
    }
    for (const v of slots.colors) {
      if (!manifest.slots[`color:${v}`]) {
        warnings.push(`CSS var --${v} is used but has no "color:${v}" manifest slot`);
      }
    }

    // All non-brand color defaults identical → renders as a solid color card.
    const colorDefaults = Object.entries(manifest.slots || {})
      .filter(([k]) => k.startsWith('color:'))
      .map(([, v]) => (typeof v === 'object' && v?.default && v.default !== 'brand'
        ? String(v.default).trim().toLowerCase() : null))
      .filter(Boolean);
    if (colorDefaults.length >= 2 && new Set(colorDefaults).size === 1) {
      warnings.push(`all ${colorDefaults.length} color slots share the same default (${colorDefaults[0]}) — the template will render as a solid color`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, slots, manifest };
}

module.exports = { scanSlots, scanContentSlots, scanColorVars, diffSlots, validate, CSS_VAR_SKIP };

'use strict';

// Pure HTML slot injection — no I/O, no side effects.
// Input: HTML string + slot data map.  Output: HTML string.

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))$/;

function isValidColor(val) {
  return typeof val === 'string' && COLOR_RE.test(val.trim());
}

// ---------------------------------------------------------------------------
// readSlotManifest
// ---------------------------------------------------------------------------

/**
 * Extract and parse the <script type="application/json" id="template-meta"> block.
 * Returns the parsed manifest object.  Throws if not found or invalid JSON.
 */
function readSlotManifest(html) {
  const startTag = '<script type="application/json" id="template-meta">';
  const altTag   = "<script type='application/json' id='template-meta'>";
  let start = html.indexOf(startTag);
  let tagLen = startTag.length;
  if (start === -1) {
    start = html.indexOf(altTag);
    tagLen = altTag.length;
  }
  if (start === -1) {
    return { slots: {}, dimensions: { width: 1080, height: 1080 } };
  }
  const end = html.indexOf('</script>', start + tagLen);
  if (end === -1) throw new Error('Unclosed <script id="template-meta"> block');
  // Strip markdown code fences that AI tools sometimes add (```json ... ```)
  const raw = html.slice(start + tagLen, end).trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  let manifest;
  try { manifest = JSON.parse(raw); } catch (e) {
    throw new Error(`Invalid JSON in template-meta: ${e.message}`);
  }
  if (!manifest.slots || typeof manifest.slots !== 'object') {
    manifest.slots = {};
  }
  if (!manifest.dimensions) {
    manifest.dimensions = { width: 1080, height: 1080 };
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// stripScriptTags
// Called at upload time to remove all <script> blocks from stored HTML.
// ---------------------------------------------------------------------------

function stripScriptTags(html) {
  // Remove all <script ...>...</script> blocks (non-greedy, case-insensitive)
  return html.replace(/<script[\s\S]*?<\/script>/gi, '');
}

// ---------------------------------------------------------------------------
// fillTextSlot
// Replaces the inner content of the first element with data-slot="key".
// Uses a character-scan approach to handle nested <span> inside slot elements.
// ---------------------------------------------------------------------------

function fillTextSlot(html, key, value) {
  const attr = `data-slot="${key}"`;
  const altAttr = `data-slot='${key}'`;

  let pos = html.indexOf(attr);
  if (pos === -1) {
    pos = html.indexOf(altAttr);
  }
  if (pos === -1) return html; // slot not present — leave HTML unchanged

  // Walk back to find the start of the opening tag '<'
  let tagStart = pos;
  while (tagStart > 0 && html[tagStart] !== '<') tagStart--;

  // Find the end of the opening tag '>'
  let tagEnd = pos;
  while (tagEnd < html.length && html[tagEnd] !== '>') tagEnd++;
  tagEnd++; // point past '>'

  // Determine the tag name (e.g. <div ...> → 'div')
  const tagMatch = html.slice(tagStart).match(/^<([a-zA-Z][a-zA-Z0-9]*)/);
  if (!tagMatch) return html; // malformed — skip
  const tagName = tagMatch[1].toLowerCase();

  // Walk from tagEnd to find the matching closing tag using bracket depth.
  // We track open/close of the same tag name.
  let depth = 1;
  let i = tagEnd;
  const openRe  = new RegExp(`<${tagName}[\\s>]`, 'i');
  const closeRe = new RegExp(`</${tagName}>`, 'i');
  while (i < html.length && depth > 0) {
    // Check for close tag first (longer match wins nothing — just check both)
    if (html[i] === '<') {
      const fragment = html.slice(i);
      if (closeRe.test(fragment.slice(0, tagName.length + 3))) {
        depth--;
        if (depth === 0) break;
        i += tagName.length + 3;
        continue;
      }
      if (openRe.test(fragment.slice(0, tagName.length + 2))) {
        depth++;
      }
    }
    i++;
  }

  // i now points to the start of the closing tag
  const closeTag = `</${tagName}>`;
  const closeIdx = html.indexOf(closeTag, i);
  if (closeIdx === -1) return html;

  const before = html.slice(0, tagEnd);
  const after  = html.slice(closeIdx);
  return before + escapeHtml(value) + after;
}

// ---------------------------------------------------------------------------
// injectColorSlots
// Prepends a <style>:root { ... }</style> block before </head>.
// Keys are e.g. "color:accent" → CSS var "--accent".
// ---------------------------------------------------------------------------

function injectColorSlots(html, colorSlots) {
  const entries = Object.entries(colorSlots);
  if (entries.length === 0) return html;

  const valid = entries.filter(([, v]) => isValidColor(v));
  if (valid.length === 0) return html;

  const vars = valid.map(([k, v]) => {
    // "color:accent" → "--accent"
    const varName = '--' + k.replace(/^color:/, '');
    return `  ${varName}: ${v};`;
  }).join('\n');
  const styleBlock = `<style>:root {\n${vars}\n}</style>\n`;

  const headClose = html.indexOf('</head>');
  if (headClose !== -1) {
    return html.slice(0, headClose) + styleBlock + html.slice(headClose);
  }
  const bodyOpen = html.indexOf('<body');
  if (bodyOpen !== -1) {
    return html.slice(0, bodyOpen) + styleBlock + html.slice(bodyOpen);
  }
  return styleBlock + html;
}

// ---------------------------------------------------------------------------
// injectImageSlot
// Replaces the src attribute of <img data-slot="image:key">.
// ---------------------------------------------------------------------------

function injectImageSlot(html, key, dataUri) {
  if (!dataUri || !dataUri.startsWith('data:image/')) return html;

  const attr = `data-slot="image:${key}"`;
  const altAttr = `data-slot='image:${key}'`;

  let pos = html.indexOf(attr);
  if (pos === -1) pos = html.indexOf(altAttr);
  if (pos === -1) return html;

  // Find the start of this <img ...> tag
  let tagStart = pos;
  while (tagStart > 0 && html[tagStart] !== '<') tagStart--;
  const tagEnd = html.indexOf('>', tagStart);
  if (tagEnd === -1) return html;

  const tagStr = html.slice(tagStart, tagEnd + 1);

  // Replace or inject the src attribute
  let newTag;
  const srcMatch = tagStr.match(/\ssrc=["'][^"']*["']/);
  if (srcMatch) {
    newTag = tagStr.replace(srcMatch[0], ` src="${dataUri}"`);
  } else {
    // inject src before the closing >
    newTag = tagStr.slice(0, -1) + ` src="${dataUri}">`;
  }

  return html.slice(0, tagStart) + newTag + html.slice(tagEnd + 1);
}

// ---------------------------------------------------------------------------
// expandRepeatingSlot
// Finds [data-slot="key"][data-slot-container], clones its [data-slot-item]
// child N times filling [data-slot-field="fieldName"] descendants.
// ---------------------------------------------------------------------------

function expandRepeatingSlot(html, key, items) {
  if (!Array.isArray(items) || items.length === 0) return html;

  const containerAttr = `data-slot="${key}"`;
  let containerPos = html.indexOf(containerAttr);
  if (containerPos === -1) return html;

  // Verify it also has data-slot-container
  let tagStart = containerPos;
  while (tagStart > 0 && html[tagStart] !== '<') tagStart--;
  const tagEnd = html.indexOf('>', tagStart);
  if (tagEnd === -1) return html;

  const tagStr = html.slice(tagStart, tagEnd + 1);
  if (!tagStr.includes('data-slot-container')) return html;

  // Extract tag name for the container
  const tagMatch = tagStr.match(/^<([a-zA-Z][a-zA-Z0-9]*)/);
  if (!tagMatch) return html;
  const containerTagName = tagMatch[1].toLowerCase();

  // Find the innerHTML of the container (from tagEnd+1 to closing tag)
  const containerOpen = tagEnd + 1;
  let depth = 1, ci = containerOpen;
  const openRe  = new RegExp(`<${containerTagName}[\\s>]`, 'i');
  const closeTag = `</${containerTagName}>`;
  while (ci < html.length && depth > 0) {
    if (html[ci] === '<') {
      const frag = html.slice(ci);
      if (frag.slice(0, closeTag.length).toLowerCase() === closeTag.toLowerCase()) {
        depth--;
        if (depth === 0) break;
        ci += closeTag.length;
        continue;
      }
      if (openRe.test(frag.slice(0, containerTagName.length + 2))) depth++;
    }
    ci++;
  }
  const containerInner = html.slice(containerOpen, ci);
  const containerClose = html.indexOf(closeTag, ci);
  if (containerClose === -1) return html;

  // Find the first [data-slot-item] child template
  const itemAttr = 'data-slot-item';
  const itemPos = containerInner.indexOf(itemAttr);
  if (itemPos === -1) return html;

  // Find the item's tag start and end
  let itemTagStart = itemPos;
  while (itemTagStart > 0 && containerInner[itemTagStart] !== '<') itemTagStart--;
  const itemOpenEnd = containerInner.indexOf('>', itemTagStart);
  if (itemOpenEnd === -1) return html;

  const itemTagStr = containerInner.slice(itemTagStart, itemOpenEnd + 1);
  const itemTagMatch = itemTagStr.match(/^<([a-zA-Z][a-zA-Z0-9]*)/);
  if (!itemTagMatch) return html;
  const itemTagName = itemTagMatch[1].toLowerCase();

  // Find item closing tag using depth scan
  let idepth = 1, ii = itemOpenEnd + 1;
  const itemOpenRe  = new RegExp(`<${itemTagName}[\\s>]`, 'i');
  const itemCloseTag = `</${itemTagName}>`;
  while (ii < containerInner.length && idepth > 0) {
    if (containerInner[ii] === '<') {
      const frag = containerInner.slice(ii);
      if (frag.slice(0, itemCloseTag.length).toLowerCase() === itemCloseTag.toLowerCase()) {
        idepth--;
        if (idepth === 0) break;
        ii += itemCloseTag.length;
        continue;
      }
      if (itemOpenRe.test(frag.slice(0, itemTagName.length + 2))) idepth++;
    }
    ii++;
  }
  const itemCloseIdx = containerInner.indexOf(itemCloseTag, ii);
  if (itemCloseIdx === -1) return html;

  const itemTemplate = containerInner.slice(itemTagStart, itemCloseIdx + itemCloseTag.length);

  // Clone the template for each item in the data array, filling [data-slot-field]
  const clones = items.map(itemData => {
    let clone = itemTemplate;
    if (itemData && typeof itemData === 'object') {
      for (const [field, val] of Object.entries(itemData)) {
        const fieldAttr = `data-slot-field="${field}"`;
        const altFieldAttr = `data-slot-field='${field}'`;
        let fPos = clone.indexOf(fieldAttr);
        if (fPos === -1) fPos = clone.indexOf(altFieldAttr);
        if (fPos === -1) continue;

        let fTagStart = fPos;
        while (fTagStart > 0 && clone[fTagStart] !== '<') fTagStart--;
        const fTagEnd = clone.indexOf('>', fTagStart);
        if (fTagEnd === -1) continue;

        const fTagStr = clone.slice(fTagStart, fTagEnd + 1);
        const fTagMatch = fTagStr.match(/^<([a-zA-Z][a-zA-Z0-9]*)/);
        if (!fTagMatch) continue;
        const fTagName = fTagMatch[1].toLowerCase();

        const fContentStart = fTagEnd + 1;
        const fCloseTag = `</${fTagName}>`;
        const fCloseIdx = clone.indexOf(fCloseTag, fContentStart);
        if (fCloseIdx === -1) continue;

        clone = clone.slice(0, fContentStart) + escapeHtml(String(val)) + clone.slice(fCloseIdx);
      }
    }
    return clone;
  }).join('\n');

  // Reassemble: container open tag + cloned items + container close tag
  const before = html.slice(0, containerOpen);
  const after  = html.slice(containerClose);
  return before + '\n' + clones + '\n' + after;
}

// ---------------------------------------------------------------------------
// injectSlots — main dispatch
// slots: flat map of slot key → value
//   text slots:      { headline: "...", tag: "..." }
//   color slots:     { "color:accent": "#ff0000", "color:bg": "#000" }
//   image slots:     { "image:photo": "data:image/jpeg;base64,..." }
//   repeating slots: { items: [{ title, body }, ...] }
// ---------------------------------------------------------------------------

function injectSlots(html, slots) {
  const colorSlots = {};
  let result = html;

  for (const [key, value] of Object.entries(slots)) {
    if (key.startsWith('color:')) {
      if (isValidColor(value)) colorSlots[key] = value;
      continue;
    }
    if (key.startsWith('image:')) {
      const imageKey = key.slice('image:'.length);
      result = injectImageSlot(result, imageKey, value);
      continue;
    }
    if (Array.isArray(value)) {
      result = expandRepeatingSlot(result, key, value);
      continue;
    }
    if (value !== null && value !== undefined) {
      result = fillTextSlot(result, key, String(value));
    }
  }

  result = injectColorSlots(result, colorSlots);
  return result;
}

module.exports = {
  readSlotManifest,
  stripScriptTags,
  injectSlots,
  fillTextSlot,
  injectColorSlots,
  injectImageSlot,
  expandRepeatingSlot,
};

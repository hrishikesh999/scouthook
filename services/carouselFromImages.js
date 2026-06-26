'use strict';

const { generateTemplateFromImage } = require('./templateFromImage');

/**
 * Convert multiple slide images into a carousel pack of HTML templates.
 *
 * The first image (title slide) converts normally and establishes the
 * "reference set" — CSS variable names, slot names, and fonts.
 * Subsequent slides convert with constraints from the reference set so
 * all templates in the pack share consistent naming.
 *
 * @param {{ buffer: Buffer, contentType: string }[]} images
 * @param {string[]} roles - parallel array: 'title' | 'content' | 'closing'
 * @returns {{ templates: { html: string, manifest: object, role: string }[], variableMap: object }}
 */
async function convertCarouselImages(images, roles, onProgress) {
  if (!images.length) throw new Error('No images provided');

  const templates = [];

  // ── Pass 1: convert the first image to establish reference set ───────────
  console.log('[carouselFromImages] converting slide 1/%d (role=%s, %d bytes)',
    images.length, roles[0], images[0].buffer.length);

  if (onProgress) await onProgress(0);

  const first = await generateTemplateFromImage(images[0].buffer, {
    contentType: images[0].contentType,
    instructions: `This is a ${roles[0]} slide in a multi-slide carousel template. Mark all editable text as data-slot and all colors as CSS custom properties.`,
  });

  templates.push({ html: first.html, manifest: first.manifest, role: roles[0] });
  if (onProgress) await onProgress(1);

  // Extract reference set from the first template's manifest
  const ref = extractReferenceSet(first.manifest, first.html);
  console.log('[carouselFromImages] reference set: %d colors, %d slots, fonts=%s',
    ref.cssVars.length, ref.slotNames.length, ref.fonts.join(', ') || 'auto');

  // ── Pass 2+: convert remaining images with carousel constraints ─────────
  for (let i = 1; i < images.length; i++) {
    const role = roles[i] || 'content';
    console.log('[carouselFromImages] converting slide %d/%d (role=%s, %d bytes)',
      i + 1, images.length, role, images[i].buffer.length);

    const constraints = buildConstraintInstructions(ref, role);
    const result = await generateTemplateFromImage(images[i].buffer, {
      contentType: images[i].contentType,
      instructions: constraints,
    });

    templates.push({ html: result.html, manifest: result.manifest, role });
    if (onProgress) await onProgress(i + 1);
  }

  // ── Build variable map ──────────────────────────────────────────────────
  const variableMap = buildVariableMap(templates);
  console.log('[carouselFromImages] conversion complete: %d templates, map has %d colors, %d slots',
    templates.length,
    Object.keys(variableMap.colors).length,
    Object.keys(variableMap.slots).length);

  return { templates, variableMap };
}

/**
 * Extract CSS variable names, slot names, and font families from a template.
 */
function extractReferenceSet(manifest, html) {
  const cssVars = [];
  const slotNames = [];
  const fonts = [];

  const slots = manifest.slots || {};
  for (const key of Object.keys(slots)) {
    if (key.startsWith('color:')) {
      cssVars.push('--' + key.slice('color:'.length));
    } else if (!key.startsWith('image:')) {
      slotNames.push(key);
    }
  }

  // Extract font families from Google Fonts link in HTML
  const fontMatch = html.match(/fonts\.googleapis\.com\/css2\?([^"']+)/);
  if (fontMatch) {
    const familyMatches = fontMatch[1].matchAll(/family=([^:&]+)/g);
    for (const m of familyMatches) {
      fonts.push(decodeURIComponent(m[1]).replace(/\+/g, ' '));
    }
  }

  return { cssVars, slotNames, fonts };
}

/**
 * Build constraint instructions for subsequent slide conversions.
 */
function buildConstraintInstructions(ref, role) {
  const parts = [
    `This is a ${role} slide in a multi-slide carousel template.`,
  ];

  if (ref.cssVars.length) {
    parts.push(
      `IMPORTANT: Use these exact CSS custom property names for colors: ${ref.cssVars.join(', ')}. ` +
      `Do NOT invent new names for the same colors. Add new variables only for colors not covered by this list.`
    );
  }

  if (ref.fonts.length) {
    parts.push(
      `Use these fonts: ${ref.fonts.join(', ')}. Match the heading/body usage from the design.`
    );
  }

  parts.push(
    'Use the same slot naming conventions as other slides in this carousel (e.g. headline, subtext, body).'
  );

  return parts.join(' ');
}

/**
 * Build a variable map that unifies CSS vars and slot names across templates.
 *
 * The map translates between pack-level canonical names and each template's
 * internal names. When constraints work perfectly, this is an identity map.
 */
function buildVariableMap(templates) {
  const colors = {};
  const slots = {};
  const fontsSet = new Set();

  // Collect all color and slot keys per role
  const byRole = {};
  for (const t of templates) {
    const role = t.role;
    if (!byRole[role]) byRole[role] = [];
    byRole[role].push(t);

    const slotDefs = t.manifest.slots || {};
    for (const key of Object.keys(slotDefs)) {
      if (key.startsWith('color:')) {
        const varName = key.slice('color:'.length);
        const canonical = varName;
        if (!colors[canonical]) colors[canonical] = {};
        colors[canonical][role] = '--' + varName;
      } else if (!key.startsWith('image:')) {
        const canonical = key;
        if (!slots[canonical]) slots[canonical] = {};
        slots[canonical][role] = key;
      }
    }

    // Collect fonts
    const fontMatch = t.html.match(/fonts\.googleapis\.com\/css2\?([^"']+)/);
    if (fontMatch) {
      const familyMatches = fontMatch[1].matchAll(/family=([^:&]+)/g);
      for (const m of familyMatches) {
        fontsSet.add(decodeURIComponent(m[1]).replace(/\+/g, ' '));
      }
    }
  }

  // Fill in nulls for roles where a canonical key doesn't exist
  const allRoles = [...new Set(templates.map(t => t.role))];
  for (const canonical of Object.keys(colors)) {
    for (const role of allRoles) {
      if (!(role in colors[canonical])) colors[canonical][role] = null;
    }
  }
  for (const canonical of Object.keys(slots)) {
    for (const role of allRoles) {
      if (!(role in slots[canonical])) slots[canonical][role] = null;
    }
  }

  const fontList = [...fontsSet];
  const fonts = {};
  if (fontList.length >= 1) fonts.heading = fontList[0];
  if (fontList.length >= 2) fonts.body = fontList[1];

  return { colors, slots, fonts };
}

module.exports = { convertCarouselImages, buildVariableMap };

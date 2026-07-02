'use strict';

const { scanContentSlots, scanColorVars, diffSlots, validate } = require('../../services/templateContract');
const { syncManifestColors } = require('../../services/templateFromImage');

function tpl({ meta, body, rootStyle = '--bg:#0f766e;--text:#ffffff;--accent:#f59e0b' } = {}) {
  return `<!DOCTYPE html><html><head>
    ${meta !== undefined ? meta : `<script type="application/json" id="template-meta">${JSON.stringify({
      slots: {
        headline: { maxLen: 80 },
        'image:photo': {},
        'color:bg': { default: 'brand', brandRole: 'bg' },
        'color:text': { default: '#ffffff' },
        'color:accent': { default: '#f59e0b' },
      },
      dimensions: { width: 1080, height: 1080 },
    })}</script>`}
    <style>h1{color:var(--text)} .hl{color:var(--accent)}</style>
  </head><body>
    <div class="root" style="${rootStyle};width:1080px;height:1080px;background:var(--bg)">
      ${body !== undefined ? body : `<h1 data-slot="headline">Title</h1><img data-slot="image:photo" src="">`}
    </div>
  </body></html>`;
}

describe('templateContract — scanContentSlots', () => {
  test('detects text, image, and repeating slots with distinct kinds', () => {
    const html = `<div data-slot="items" data-slot-container>
        <div data-slot-item><span data-slot-field="title">t</span></div>
      </div>
      <h1 data-slot="headline">x</h1>
      <img data-slot="image:photo" src="">`;
    const slots = scanContentSlots(html);
    expect(slots).toEqual(expect.arrayContaining([
      { key: 'items', kind: 'repeating' },
      { key: 'headline', kind: 'text' },
      { key: 'image:photo', kind: 'image' },
    ]));
    expect(slots).toHaveLength(3);
  });

  test('deduplicates repeated keys', () => {
    const slots = scanContentSlots('<p data-slot="a">1</p><p data-slot="a">2</p>');
    expect(slots).toHaveLength(1);
  });
});

describe('templateContract — scanColorVars', () => {
  test('finds var(--x) usages and skips design-system vars', () => {
    const vars = scanColorVars('<div style="color:var(--text_dark);border-radius:var(--radius);gap:var(--space-md)"><style>p{background:var(--bg)}</style></div>');
    expect(vars).toEqual(['bg', 'text_dark']);
  });
});

describe('templateContract — diffSlots', () => {
  test('reports lost and added slots across a mutation', () => {
    const before = tpl();
    const after = tpl({ body: '<h1>Title without slot</h1><p data-slot="subtitle">new</p>', rootStyle: '--bg:#111' })
      .replace(/<style>[\s\S]*?<\/style>/, '<style>h1{color:#fff}</style>'); // --text/--accent no longer used anywhere
    const diff = diffSlots(before, after);
    expect(diff.lostContent).toEqual(expect.arrayContaining(['headline', 'image:photo']));
    expect(diff.addedContent).toEqual(['subtitle']);
    expect(diff.lostColors).toEqual(expect.arrayContaining(['accent', 'text']));
    expect(diff.lostColors).not.toContain('bg');
  });

  test('no differences on identical documents', () => {
    const html = tpl();
    const diff = diffSlots(html, html);
    expect(diff.lostContent).toEqual([]);
    expect(diff.lostColors).toEqual([]);
    expect(diff.addedContent).toEqual([]);
    expect(diff.addedColors).toEqual([]);
  });
});

describe('templateContract — validate', () => {
  test('a consistent template passes with no errors or warnings', () => {
    const r = validate(tpl());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test('unparseable template-meta is a hard error', () => {
    const r = validate(tpl({ meta: '<script type="application/json" id="template-meta">{not json</script>' }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/template-meta/);
  });

  test('manifest slot with no bound element is a warning (orphaned)', () => {
    const r = validate(tpl({ body: '<img data-slot="image:photo" src="">' })); // headline unbound
    expect(r.ok).toBe(true);
    expect(r.warnings.some(w => w.includes('"headline"') && w.includes('orphaned'))).toBe(true);
  });

  test('CSS var without a manifest color slot is a warning', () => {
    const html = tpl().replace('--accent:#f59e0b', '--accent:#f59e0b;--extra:#123456')
      .replace('</style>', ' .x{color:var(--extra)}</style>');
    const r = validate(html);
    expect(r.warnings.some(w => w.includes('--extra'))).toBe(true);
  });

  test('all-identical non-brand color defaults produce the solid-color warning; brand defaults are exempt', () => {
    const meta = `<script type="application/json" id="template-meta">${JSON.stringify({
      slots: {
        'color:bg': { default: '#cccccc' },
        'color:text': { default: '#cccccc' },
        'color:accent': { default: 'brand', brandRole: 'accent' },
      },
      dimensions: { width: 1080, height: 1080 },
    })}</script>`;
    const r = validate(tpl({ meta, body: '<h1>x</h1>' }));
    expect(r.warnings.some(w => w.includes('solid color'))).toBe(true);
  });
});

describe('templateFromImage — syncManifestColors brand preservation', () => {
  test('does not overwrite default:"brand" with the hex found in the HTML', () => {
    const manifest = {
      slots: {
        'color:bg': { default: 'brand', brandRole: 'bg' },
        'color:text': { default: '#000000' },
      },
      dimensions: { width: 1080, height: 1080 },
    };
    const html = `<html><head><script type="application/json" id="template-meta">${JSON.stringify(manifest)}</script></head>
      <body><div class="root" style="--bg:#0f766e;--text:#fafafa">x</div></body></html>`;
    syncManifestColors(html, manifest);
    expect(manifest.slots['color:bg'].default).toBe('brand');       // mapping preserved
    expect(manifest.slots['color:bg'].brandRole).toBe('bg');
    expect(manifest.slots['color:text'].default).toBe('#fafafa');   // literal still synced
  });
});

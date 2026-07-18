'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Carousel Studio — Level 3 deck editor.
//
// Structured content editing with bounded design freedom: users edit slot
// text (form fields or inline in the preview), reorder/duplicate/delete
// slides, switch layout variants, toggle decorations, and override pack
// colors. Layout itself is never editable — that is curated admin-side.
//
// Entry point: window.CarouselStudio.open(packId)
// Depends on globals from editor.html/session.js:
//   currentPostId, apiHeaders(), _doSaveCarouselPack(pdfUrl, previewUrl, count, btn)
//
// Data flow: deck draft (POST/GET/PUT /api/posts/:id/carousel-draft) is the
// single source of truth. Previews render the SAME template HTML the server
// renders, with slots/colors applied by a bootstrap script inside each
// iframe — preview and published PDF agree by construction.
// ─────────────────────────────────────────────────────────────────────────────

(function () {

  // ── State ────────────────────────────────────────────────────────────────
  let deck = null;          // the deck document (mutated in place, autosaved)
  let pack = null;          // pack detail: slides, variants, variable_map
  let tplHtml = {};         // template_id → raw HTML
  let tplById = {};         // template_id → { role, slot_manifest, template_name, variant_group }
  let activeIdx = 0;
  let saveTimer = null;
  let saveState = 'saved';  // 'saved' | 'saving' | 'dirty' | 'error'
  let renderPollTimer = null;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Content-class roles sit in the swipeable middle: reorderable, duplicable,
  // deletable, interchangeable. Title (cover) and closing (payoff) are pinned.
  const CONTENT_CLASS = new Set(['content', 'stat', 'list', 'quote', 'comparison', 'cta']);
  const isContent = role => CONTENT_CLASS.has(role);
  const contentCount = () => deck.slides.filter(s => isContent(s.role)).length;

  // ── Slot mapping: canonical ↔ template-specific ──────────────────────────

  function slotMapsFor(role) {
    const canonicalToTpl = {}, tplToCanonical = {};
    const slots = (pack.variable_map && pack.variable_map.slots) || {};
    for (const [canonical, roleMap] of Object.entries(slots)) {
      const tplKey = roleMap && roleMap[role];
      if (tplKey) { canonicalToTpl[canonical] = tplKey; tplToCanonical[tplKey] = canonical; }
    }
    return { canonicalToTpl, tplToCanonical };
  }

  function colorVarsFor(role) {
    // canonical color name → CSS var name for this role's template
    const out = {};
    const colors = (pack.variable_map && pack.variable_map.colors) || {};
    for (const [canonical, roleMap] of Object.entries(colors)) {
      const cssVar = roleMap && roleMap[role];
      if (cssVar) out[canonical] = cssVar; // e.g. '--bg'
    }
    return out;
  }

  // Editable canonical slots for a slide: union of its stored slots and the
  // manifest text slots of its template (mapped back to canonical names).
  function editableSlots(slide) {
    const { tplToCanonical } = slotMapsFor(slide.role);
    const keys = new Set(Object.keys(slide.slots || {}));
    const manifest = tplById[slide.template_id]?.slot_manifest || {};
    for (const key of Object.keys(manifest.slots || {})) {
      if (key.startsWith('color:') || key.startsWith('image:')) continue;
      keys.add(tplToCanonical[key] || key);
    }
    return [...keys];
  }

  // ── Preview documents ─────────────────────────────────────────────────────

  const BOOTSTRAP = `
<script>
(function(){
  var payload = JSON.parse(document.getElementById('cstudio-payload').textContent);
  var root = document.body.firstElementChild || document.body;
  Object.entries(payload.colors || {}).forEach(function(e){ root.style.setProperty(e[0], e[1]); });
  Object.entries(payload.slots || {}).forEach(function(e){
    document.querySelectorAll('[data-slot="'+e[0]+'"]').forEach(function(el){
      if (Array.isArray(e[1])) el.textContent = e[1].join('\\n'); else el.textContent = e[1];
    });
  });
  if (payload.editable) {
    document.querySelectorAll('[data-slot]').forEach(function(el){
      var key = el.getAttribute('data-slot');
      if ((payload.textKeys || []).indexOf(key) === -1) return;
      el.setAttribute('contenteditable', 'plaintext-only');
      el.style.outline = 'none';
      el.style.cursor = 'text';
      el.addEventListener('focus', function(){ el.style.boxShadow = '0 0 0 2px rgba(15,118,110,.7)'; });
      el.addEventListener('blur',  function(){ el.style.boxShadow = 'none'; });
      el.addEventListener('input', function(){
        parent.postMessage({ type: 'cstudio-slot-input', tplKey: key, value: el.textContent }, '*');
      });
    });
  }
})();
<\/script>`;

  function decoOverlayHtml(idx, total, dims) {
    const deco = deck.settings?.decorations || {};
    if (!deco.pageNumbers && !deco.swipeCue && !deco.byline?.enabled) return '';
    const scale = (dims.width || 1080) / 1080;
    const px = n => Math.round(n * scale) + 'px';
    const pill = `display:flex;align-items:center;gap:${px(10)};background:rgba(0,0,0,0.38);color:#fff;border-radius:999px;padding:${px(8)} ${px(18)};font:600 ${px(22)}/1.2 Inter,-apple-system,sans-serif;`;
    const left = [], right = [];
    if (deco.byline?.enabled && deco.byline.name) left.push(`<div style="${pill}">${esc(deco.byline.name)}</div>`);
    if (deco.pageNumbers && idx > 0) right.push(`<div style="${pill}">${idx + 1} / ${total}</div>`);
    if (deco.swipeCue && idx < total - 1) right.push(`<div style="${pill}">${idx === 0 ? 'swipe' : ''}&nbsp;&#8594;</div>`);
    if (!left.length && !right.length) return '';
    return `<div style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;display:flex;justify-content:space-between;align-items:center;padding:${px(28)} ${px(36)};pointer-events:none;">` +
      `<div style="display:flex;gap:${px(12)}">${left.join('')}</div><div style="display:flex;gap:${px(12)}">${right.join('')}</div></div>`;
  }

  function buildSlideDoc(slide, idx, editable) {
    const html = tplHtml[slide.template_id];
    if (!html) return '<html><body style="display:flex;align-items:center;justify-content:center;font-family:sans-serif;color:#999">Loading…</body></html>';

    const { canonicalToTpl } = slotMapsFor(slide.role);
    const tplSlots = {};
    const textKeys = [];
    for (const [canonical, value] of Object.entries(slide.slots || {})) {
      const tplKey = canonicalToTpl[canonical] || canonical;
      tplSlots[tplKey] = value;
      textKeys.push(tplKey);
    }
    // Manifest text slots with no stored value are still editable inline
    const manifest = tplById[slide.template_id]?.slot_manifest || {};
    for (const key of Object.keys(manifest.slots || {})) {
      if (key.startsWith('color:') || key.startsWith('image:')) continue;
      if (!textKeys.includes(key)) textKeys.push(key);
    }

    const colorVars = colorVarsFor(slide.role);
    const colors = {};
    for (const [canonical, hex] of Object.entries(deck.settings?.theme?.colors || {})) {
      const cssVar = colorVars[canonical];
      if (cssVar) colors[cssVar] = hex;
    }

    const dims = manifest.dimensions || { width: 1080, height: 1080 };
    const payload = `<script type="application/json" id="cstudio-payload">${
      JSON.stringify({ slots: tplSlots, colors, editable: !!editable, textKeys })
        .replace(/</g, '\\u003c')
    }<\/script>`;

    const overlay = decoOverlayHtml(idx, deck.slides.length, dims);
    const inject = payload + BOOTSTRAP + overlay;
    return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, inject + '</body>') : html + inject;
  }

  function slideDims(slide) {
    return tplById[slide.template_id]?.slot_manifest?.dimensions || { width: 1080, height: 1080 };
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  function markDirty() {
    saveState = 'dirty';
    updateSaveBadge();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 1000);
  }

  async function saveDraft() {
    saveState = 'saving'; updateSaveBadge();
    try {
      const r = await fetch(`/api/posts/${encodeURIComponent(String(currentPostId))}/carousel-draft`, {
        method: 'PUT', headers: apiHeaders(), credentials: 'include',
        body: JSON.stringify({ deck }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'save_failed');
      saveState = 'saved';
    } catch (err) {
      console.error('[carousel-studio] autosave failed:', err.message);
      saveState = 'error';
    }
    updateSaveBadge();
  }

  function updateSaveBadge() {
    const el = $('#cstudio-save-badge');
    if (!el) return;
    el.textContent = saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed — retrying' : 'Editing…';
    el.style.color = saveState === 'error' ? '#dc2626' : 'var(--text-muted, #6b7280)';
    if (saveState === 'error') { clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 4000); }
  }

  // ── UI scaffold ───────────────────────────────────────────────────────────

  const CSS = `
#cstudio-overlay { position:fixed; inset:0; z-index:10000; background:rgba(9,9,11,.55); display:flex; align-items:stretch; justify-content:center; }
#cstudio { background:var(--surface,#fff); margin:16px; border-radius:14px; flex:1; max-width:1400px; display:flex; flex-direction:column; overflow:hidden; box-shadow:0 24px 64px rgba(0,0,0,.35); }
#cstudio header { display:flex; align-items:center; gap:14px; padding:12px 18px; border-bottom:1px solid var(--border,#e5e7eb); }
#cstudio header h2 { font-size:15px; font-weight:700; margin:0; flex:1; letter-spacing:.02em; }
#cstudio-body { display:flex; flex:1; min-height:0; }
#cstudio-rail { width:148px; border-right:1px solid var(--border,#e5e7eb); overflow-y:auto; padding:10px; display:flex; flex-direction:column; gap:8px; background:var(--neutral-50,#f9fafb); }
.cstudio-thumb { position:relative; border:2px solid transparent; border-radius:8px; overflow:hidden; cursor:pointer; background:#fff; flex-shrink:0; }
.cstudio-thumb.active { border-color:var(--brand,#0f766e); }
.cstudio-thumb .num { position:absolute; top:4px; left:4px; z-index:2; background:rgba(0,0,0,.55); color:#fff; font:700 10px/1 Inter,sans-serif; padding:3px 6px; border-radius:99px; }
.cstudio-thumb iframe { border:0; pointer-events:none; transform-origin:top left; display:block; }
.cstudio-thumb .acts { position:absolute; bottom:4px; right:4px; z-index:2; display:none; gap:3px; }
.cstudio-thumb:hover .acts { display:flex; }
.cstudio-thumb .acts button { border:0; background:rgba(0,0,0,.6); color:#fff; border-radius:5px; font-size:10px; padding:3px 5px; cursor:pointer; }
#cstudio-add { border:2px dashed var(--border,#d1d5db); border-radius:8px; background:none; color:var(--text-muted,#6b7280); font-size:12px; padding:10px 0; cursor:pointer; }
#cstudio-canvas { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; background:var(--neutral-100,#f3f4f6); min-width:0; padding:16px; gap:10px; }
#cstudio-canvas-frame { background:#fff; box-shadow:0 6px 28px rgba(0,0,0,.14); border-radius:4px; overflow:hidden; }
#cstudio-canvas iframe { border:0; transform-origin:top left; display:block; }
#cstudio-variants { display:flex; gap:6px; flex-wrap:wrap; justify-content:center; }
#cstudio-variants button { border:1px solid var(--border,#d1d5db); background:#fff; border-radius:7px; font-size:11px; padding:5px 10px; cursor:pointer; }
#cstudio-variants button.active { border-color:var(--brand,#0f766e); color:var(--brand,#0f766e); font-weight:700; }
#cstudio-side { width:330px; border-left:1px solid var(--border,#e5e7eb); display:flex; flex-direction:column; min-height:0; }
#cstudio-tabs { display:flex; border-bottom:1px solid var(--border,#e5e7eb); }
#cstudio-tabs button { flex:1; border:0; background:none; padding:10px; font-size:12.5px; font-weight:600; color:var(--text-muted,#6b7280); cursor:pointer; border-bottom:2px solid transparent; }
#cstudio-tabs button.active { color:var(--brand,#0f766e); border-bottom-color:var(--brand,#0f766e); }
#cstudio-panel { flex:1; overflow-y:auto; padding:14px; }
.cstudio-field { margin-bottom:12px; }
.cstudio-field label { display:block; font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted,#6b7280); margin-bottom:4px; }
.cstudio-field textarea { width:100%; border:1px solid var(--border,#d1d5db); border-radius:7px; padding:8px 10px; font-size:13px; font-family:inherit; resize:vertical; min-height:38px; }
.cstudio-ai-row { display:flex; gap:6px; margin-bottom:14px; flex-wrap:wrap; }
.cstudio-ai-row button { border:1px solid var(--border,#d1d5db); background:#fff; border-radius:99px; font-size:11.5px; padding:5px 12px; cursor:pointer; }
.cstudio-ai-row button:disabled { opacity:.5; cursor:default; }
.cstudio-toggle { display:flex; align-items:center; justify-content:space-between; padding:9px 0; border-bottom:1px solid var(--neutral-100,#f3f4f6); font-size:13px; }
.cstudio-color-row { display:flex; align-items:center; justify-content:space-between; padding:7px 0; font-size:12.5px; }
.cstudio-color-row input[type=color] { width:34px; height:26px; border:1px solid var(--border,#d1d5db); border-radius:6px; padding:1px; cursor:pointer; }
#cstudio-footer { border-top:1px solid var(--border,#e5e7eb); padding:11px 18px; display:flex; align-items:center; gap:12px; }
#cstudio-generate { margin-left:auto; background:var(--brand,#0f766e); color:#fff; border:0; border-radius:9px; font-size:13.5px; font-weight:700; padding:10px 22px; cursor:pointer; }
#cstudio-generate:disabled { opacity:.6; cursor:default; }
.cstudio-cover-opts { display:flex; flex-direction:column; gap:6px; margin-bottom:14px; }
.cstudio-cover-opts button { text-align:left; border:1px solid var(--border,#d1d5db); background:#fff; border-radius:8px; padding:8px 10px; font-size:12.5px; cursor:pointer; }
.cstudio-cover-opts button.active { border-color:var(--brand,#0f766e); background:rgba(15,118,110,.05); }
`;

  function scaffold() {
    if ($('#cstudio-overlay')) return;
    const style = document.createElement('style');
    style.id = 'cstudio-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    const el = document.createElement('div');
    el.id = 'cstudio-overlay';
    el.innerHTML = `
      <div id="cstudio" role="dialog" aria-label="Carousel Studio">
        <header>
          <h2 id="cstudio-title">CAROUSEL STUDIO</h2>
          <span id="cstudio-save-badge" style="font-size:12px"></span>
          <button id="cstudio-close" class="btn-text" style="border:0;background:none;font-size:20px;cursor:pointer;line-height:1">&times;</button>
        </header>
        <div id="cstudio-body">
          <div id="cstudio-rail"></div>
          <div id="cstudio-canvas">
            <div id="cstudio-canvas-frame"></div>
            <div id="cstudio-variants"></div>
          </div>
          <div id="cstudio-side">
            <div id="cstudio-tabs">
              <button data-tab="content" class="active">Content</button>
              <button data-tab="design">Design</button>
            </div>
            <div id="cstudio-panel"></div>
          </div>
        </div>
        <div id="cstudio-footer">
          <span id="cstudio-status" style="font-size:12.5px;color:var(--text-muted,#6b7280)"></span>
          <button id="cstudio-generate">Generate Carousel</button>
        </div>
      </div>`;
    document.body.appendChild(el);

    $('#cstudio-close').addEventListener('click', close);
    el.addEventListener('click', e => { if (e.target === el) close(); });
    $('#cstudio-tabs').addEventListener('click', e => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      $('#cstudio-tabs .active')?.classList.remove('active');
      btn.classList.add('active');
      renderPanel(btn.dataset.tab);
    });
    $('#cstudio-generate').addEventListener('click', generate);

    window.addEventListener('message', onIframeMessage);
  }

  function close() {
    clearTimeout(saveTimer);
    clearInterval(renderPollTimer);
    if (saveState === 'dirty' || saveState === 'saving') saveDraft();
    window.removeEventListener('message', onIframeMessage);
    $('#cstudio-overlay')?.remove();
    $('#cstudio-style')?.remove();
    deck = pack = null; tplHtml = {}; tplById = {}; activeIdx = 0;
  }

  // ── Inline editing plumbing ───────────────────────────────────────────────

  let inlineDebounce = null;
  function onIframeMessage(e) {
    const msg = e.data;
    if (!msg || msg.type !== 'cstudio-slot-input' || !deck) return;
    const slide = deck.slides[activeIdx];
    if (!slide) return;
    const { tplToCanonical } = slotMapsFor(slide.role);
    const canonical = tplToCanonical[msg.tplKey] || msg.tplKey;
    slide.slots[canonical] = msg.value;
    slide.locked = true;
    markDirty();
    // Sync the form field without re-rendering the iframe (would drop focus)
    const field = $(`#cstudio-panel textarea[data-slot-key="${CSS_escape(canonical)}"]`);
    if (field && field.value !== msg.value) field.value = msg.value;
    clearTimeout(inlineDebounce);
    inlineDebounce = setTimeout(() => renderRailThumb(activeIdx), 600);
  }

  function CSS_escape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/"/g, '\\"'); }

  // ── Rendering the three regions ───────────────────────────────────────────

  function railThumbHeight() { return 118; }

  function renderRail() {
    const rail = $('#cstudio-rail');
    rail.innerHTML = '';
    deck.slides.forEach((slide, i) => {
      const dims = slideDims(slide);
      const thumbW = 124;
      const scale = thumbW / dims.width;
      const div = document.createElement('div');
      div.className = 'cstudio-thumb' + (i === activeIdx ? ' active' : '');
      div.dataset.idx = i;
      div.draggable = isContent(slide.role);
      div.style.height = Math.round(dims.height * scale) + 'px';
      div.innerHTML = `
        <span class="num">${i + 1}</span>
        <iframe style="width:${dims.width}px;height:${dims.height}px;transform:scale(${scale})" sandbox="allow-scripts" tabindex="-1"></iframe>
        <div class="acts">
          ${isContent(slide.role) ? '<button data-act="dup" title="Duplicate">⧉</button>' : ''}
          ${isContent(slide.role) && contentCount() > 1 ? '<button data-act="del" title="Delete">✕</button>' : ''}
        </div>`;
      div.querySelector('iframe').srcdoc = buildSlideDoc(slide, i, false);
      div.addEventListener('click', e => {
        const act = e.target.closest('button[data-act]');
        if (act) { e.stopPropagation(); slideAction(act.dataset.act, i); return; }
        selectSlide(i);
      });
      // Drag reorder (content slides only, between title and closing)
      div.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', String(i)); });
      div.addEventListener('dragover', e => { if (isContent(slide.role)) e.preventDefault(); });
      div.addEventListener('drop', e => {
        e.preventDefault();
        const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (Number.isNaN(from) || from === i) return;
        if (!isContent(deck.slides[from]?.role) || !isContent(slide.role)) return;
        const [moved] = deck.slides.splice(from, 1);
        deck.slides.splice(i, 0, moved);
        activeIdx = i;
        markDirty(); renderAll();
      });
      rail.appendChild(div);
    });

    const add = document.createElement('button');
    add.id = 'cstudio-add';
    add.textContent = '+ Add slide';
    add.addEventListener('click', addSlide);
    rail.appendChild(add);
  }

  function renderRailThumb(i) {
    const iframe = $(`#cstudio-rail .cstudio-thumb[data-idx="${i}"] iframe`);
    if (iframe) iframe.srcdoc = buildSlideDoc(deck.slides[i], i, false);
  }

  function renderCanvas() {
    const slide = deck.slides[activeIdx];
    const frame = $('#cstudio-canvas-frame');
    const canvas = $('#cstudio-canvas');
    const dims = slideDims(slide);
    const availH = canvas.clientHeight - 70, availW = canvas.clientWidth - 40;
    const scale = Math.min(availH / dims.height, availW / dims.width, 0.62);
    frame.style.width = Math.round(dims.width * scale) + 'px';
    frame.style.height = Math.round(dims.height * scale) + 'px';
    frame.innerHTML = `<iframe style="width:${dims.width}px;height:${dims.height}px;transform:scale(${scale})" sandbox="allow-scripts"></iframe>`;
    frame.querySelector('iframe').srcdoc = buildSlideDoc(slide, activeIdx, true);
    renderVariantSwitcher(slide);
  }

  function renderVariantSwitcher(slide) {
    const host = $('#cstudio-variants');
    const group = tplById[slide.template_id]?.variant_group;
    const options = [];
    // Same-role alternatives: base pack templates + variant siblings
    for (const [id, t] of Object.entries(tplById)) {
      if (t.role !== slide.role) continue;
      if (group ? (t.variant_group === group || id === slide.template_id) : true) options.push({ id, name: t.template_name });
    }
    if (options.length < 2) { host.innerHTML = ''; return; }
    host.innerHTML = options.map((o, n) =>
      `<button data-tpl="${esc(o.id)}" class="${o.id === slide.template_id ? 'active' : ''}" title="${esc(o.name || '')}">Layout ${String.fromCharCode(65 + n)}</button>`
    ).join('');
    host.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
      slide.template_id = btn.dataset.tpl;
      slide.locked = true;
      markDirty();
      ensureTemplateHtml(slide.template_id).then(() => { renderCanvas(); renderRailThumb(activeIdx); });
    }));
  }

  function renderPanel(tab) {
    tab = tab || $('#cstudio-tabs .active')?.dataset.tab || 'content';
    const panel = $('#cstudio-panel');
    const slide = deck.slides[activeIdx];

    if (tab === 'content') {
      let html = '';

      // Cover options (Phase 5 planner output) on the title slide
      const opts = deck.meta?.title_options;
      if (slide.role === 'title' && Array.isArray(opts) && opts.length > 1) {
        html += `<div class="cstudio-field"><label>Cover options</label><div class="cstudio-cover-opts">` +
          opts.map((o, n) => {
            const first = Object.values(o).find(v => typeof v === 'string' && v);
            const isActive = Object.entries(o).every(([k, v]) => slide.slots[k] === v);
            return `<button data-opt="${n}" class="${isActive ? 'active' : ''}">${esc(first || `Option ${n + 1}`)}</button>`;
          }).join('') + `</div></div>`;
      }

      html += `<div class="cstudio-ai-row">
        <button data-ai="rewrite">↻ Rewrite</button>
        <button data-ai="shorten">– Shorten</button>
        <button data-ai="punchier">⚡ Punchier</button>
      </div>`;

      for (const key of editableSlots(slide)) {
        const val = slide.slots[key];
        const display = Array.isArray(val) ? val.join('\n') : (val || '');
        html += `<div class="cstudio-field">
          <label>${esc(key.replace(/[_:]/g, ' '))}</label>
          <textarea data-slot-key="${esc(key)}" rows="${display.length > 80 ? 3 : 1}">${esc(display)}</textarea>
        </div>`;
      }
      panel.innerHTML = html;

      panel.querySelectorAll('.cstudio-cover-opts button').forEach(btn => btn.addEventListener('click', () => {
        const o = deck.meta.title_options[parseInt(btn.dataset.opt, 10)];
        Object.assign(slide.slots, o);
        slide.locked = true;
        markDirty(); renderCanvas(); renderRailThumb(activeIdx); renderPanel('content');
      }));

      panel.querySelectorAll('textarea[data-slot-key]').forEach(ta => ta.addEventListener('input', () => {
        const key = ta.dataset.slotKey;
        const prev = slide.slots[key];
        slide.slots[key] = Array.isArray(prev) ? ta.value.split('\n') : ta.value;
        slide.locked = true;
        markDirty();
        clearTimeout(inlineDebounce);
        inlineDebounce = setTimeout(() => { renderCanvas(); renderRailThumb(activeIdx); }, 450);
      }));

      panel.querySelectorAll('button[data-ai]').forEach(btn => btn.addEventListener('click', () => aiRewrite(btn.dataset.ai, btn)));
      return;
    }

    // Design tab
    const deco = deck.settings.decorations;
    const colorNames = Object.keys((pack.variable_map && pack.variable_map.colors) || {});
    let html = `<div class="cstudio-field"><label>Aspect</label>
      <div style="font-size:13px">${deck.settings.aspect === 'portrait' ? 'Portrait 1080×1350' : 'Square 1080×1080'}</div></div>`;

    if (colorNames.length) {
      html += `<div class="cstudio-field"><label>Colors</label>` + colorNames.map(name => {
        const val = deck.settings.theme.colors[name] || '';
        return `<div class="cstudio-color-row"><span>${esc(name.replace(/[_-]/g, ' '))}</span>
          <span style="display:flex;gap:6px;align-items:center">
            ${val ? `<button data-reset-color="${esc(name)}" style="border:0;background:none;font-size:11px;color:var(--text-muted,#6b7280);cursor:pointer">reset</button>` : ''}
            <input type="color" data-color-name="${esc(name)}" value="${esc(val || '#888888')}">
          </span></div>`;
      }).join('') + `</div>`;
    }

    html += `<div class="cstudio-field"><label>Decorations</label>
      <div class="cstudio-toggle"><span>Page numbers</span><input type="checkbox" data-deco="pageNumbers" ${deco.pageNumbers ? 'checked' : ''}></div>
      <div class="cstudio-toggle"><span>Swipe cue</span><input type="checkbox" data-deco="swipeCue" ${deco.swipeCue ? 'checked' : ''}></div>
      <div class="cstudio-toggle"><span>Author byline</span><input type="checkbox" data-deco="byline" ${deco.byline.enabled ? 'checked' : ''}></div>
      <div class="cstudio-field" style="margin-top:8px ${deco.byline.enabled ? '' : ';display:none'}" id="cstudio-byline-name">
        <label>Byline name (blank = LinkedIn name)</label>
        <textarea rows="1" data-byline-name>${esc(deco.byline.name || '')}</textarea>
      </div></div>`;

    panel.innerHTML = html;

    panel.querySelectorAll('input[data-color-name]').forEach(inp => inp.addEventListener('input', () => {
      deck.settings.theme.colors[inp.dataset.colorName] = inp.value;
      markDirty(); refreshAllPreviews();
    }));
    panel.querySelectorAll('button[data-reset-color]').forEach(btn => btn.addEventListener('click', () => {
      delete deck.settings.theme.colors[btn.dataset.resetColor];
      markDirty(); refreshAllPreviews(); renderPanel('design');
    }));
    panel.querySelectorAll('input[data-deco]').forEach(inp => inp.addEventListener('change', () => {
      if (inp.dataset.deco === 'byline') deco.byline.enabled = inp.checked;
      else deco[inp.dataset.deco] = inp.checked;
      markDirty(); refreshAllPreviews();
      const nameField = $('#cstudio-byline-name');
      if (nameField) nameField.style.display = deco.byline.enabled ? '' : 'none';
    }));
    const bylineName = panel.querySelector('textarea[data-byline-name]');
    if (bylineName) bylineName.addEventListener('input', () => {
      deco.byline.name = bylineName.value.slice(0, 80);
      markDirty();
      clearTimeout(inlineDebounce);
      inlineDebounce = setTimeout(refreshAllPreviews, 500);
    });
  }

  function refreshAllPreviews() {
    renderCanvas();
    deck.slides.forEach((_, i) => renderRailThumb(i));
  }

  function renderAll() {
    renderRail();
    renderCanvas();
    renderPanel();
  }

  function selectSlide(i) {
    activeIdx = Math.max(0, Math.min(i, deck.slides.length - 1));
    $('#cstudio-rail .cstudio-thumb.active')?.classList.remove('active');
    $(`#cstudio-rail .cstudio-thumb[data-idx="${activeIdx}"]`)?.classList.add('active');
    renderCanvas();
    renderPanel();
  }

  // ── Slide operations ──────────────────────────────────────────────────────

  function slideAction(act, i) {
    const slide = deck.slides[i];
    if (act === 'dup' && isContent(slide.role)) {
      const copy = JSON.parse(JSON.stringify(slide));
      copy.id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
      deck.slides.splice(i + 1, 0, copy);
      activeIdx = i + 1;
    } else if (act === 'del' && isContent(slide.role)) {
      if (contentCount() <= 1) return;
      deck.slides.splice(i, 1);
      activeIdx = Math.min(activeIdx, deck.slides.length - 1);
    } else return;
    markDirty(); renderAll();
  }

  function addSlide() {
    // Prefer reusing a content-class template already in the deck; else any
    // content-class template the pack provides.
    const contentTpl = deck.slides.find(s => isContent(s.role)) ||
      Object.entries(tplById).map(([id, t]) => ({ template_id: id, ...t })).find(t => isContent(t.role));
    if (!contentTpl) return;
    const insertAt = deck.slides.findIndex(s => s.role === 'closing');
    const slide = {
      id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      template_id: contentTpl.template_id,
      role: contentTpl.role || 'content',
      locked: true,
      slots: {},
    };
    deck.slides.splice(insertAt === -1 ? deck.slides.length : insertAt, 0, slide);
    activeIdx = insertAt === -1 ? deck.slides.length - 1 : insertAt;
    markDirty(); renderAll();
  }

  // ── AI actions ────────────────────────────────────────────────────────────

  async function aiRewrite(action, btn) {
    const slide = deck.slides[activeIdx];
    const row = btn.closest('.cstudio-ai-row');
    row.querySelectorAll('button').forEach(b => b.disabled = true);
    const original = btn.textContent;
    btn.textContent = 'Working…';
    try {
      const r = await fetch(`/api/posts/${encodeURIComponent(String(currentPostId))}/carousel-draft/slide-rewrite`, {
        method: 'POST', headers: apiHeaders(), credentials: 'include',
        body: JSON.stringify({ slide_id: slide.id, action }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'rewrite_failed');
      slide.slots = { ...slide.slots, ...data.slots };
      slide.locked = true;
      markDirty(); renderCanvas(); renderRailThumb(activeIdx); renderPanel('content');
    } catch (err) {
      alert('AI action failed: ' + err.message);
      row.querySelectorAll('button').forEach(b => b.disabled = false);
      btn.textContent = original;
    }
  }

  // ── Generate ──────────────────────────────────────────────────────────────

  async function generate() {
    const btn = $('#cstudio-generate');
    const status = $('#cstudio-status');
    btn.disabled = true; btn.textContent = 'Rendering…';
    clearTimeout(saveTimer);
    try {
      await saveDraft();
      if (saveState === 'error') throw new Error('Could not save the deck');

      const r = await fetch(`/api/posts/${encodeURIComponent(String(currentPostId))}/carousel-draft/render`, {
        method: 'POST', headers: apiHeaders(), credentials: 'include', body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'render_failed');

      renderPollTimer = setInterval(async () => {
        try {
          const jr = await fetch(`/api/visuals/jobs/${data.job_id}`, { headers: apiHeaders(), credentials: 'include' });
          const job = await jr.json();
          if (job.progress?.total > 0) status.textContent = `Rendering slide ${job.progress.current} of ${job.progress.total}…`;
          if (job.status === 'done') {
            clearInterval(renderPollTimer);
            status.textContent = `${(job.slides || []).length} slides ready.`;
            btn.textContent = 'Generate Carousel'; btn.disabled = false;
            showResult(job);
          } else if (job.status === 'failed') {
            clearInterval(renderPollTimer);
            throw new Error(job.error || 'render_failed');
          }
        } catch (err) {
          clearInterval(renderPollTimer);
          status.textContent = '';
          btn.textContent = 'Generate Carousel'; btn.disabled = false;
          alert('Render failed: ' + err.message);
        }
      }, 2500);
    } catch (err) {
      status.textContent = '';
      btn.textContent = 'Generate Carousel'; btn.disabled = false;
      alert(err.message);
    }
  }

  function showResult(job) {
    const panel = $('#cstudio-panel');
    $('#cstudio-tabs .active')?.classList.remove('active');
    const slides = job.slides || [];
    panel.innerHTML = `
      <div class="cstudio-field"><label>Result</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${slides.map(s => `<img src="${esc(s.png_url)}" alt="Slide ${s.slide_index}" style="width:88px;border-radius:6px;border:1px solid var(--border,#e5e7eb)">`).join('')}
        </div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap">
        <button id="cstudio-insert" class="btn-secondary" style="border:1px solid var(--brand,#0f766e);color:var(--brand,#0f766e);background:#fff;border-radius:8px;padding:8px 16px;font-weight:700;cursor:pointer">Insert in Post</button>
        ${job.pdf_url ? `<a href="${esc(job.pdf_url)}" target="_blank" download style="font-size:13px">Download PDF</a>` : ''}
      </div>`;
    $('#cstudio-insert')?.addEventListener('click', async (e) => {
      if (typeof _doSaveCarouselPack === 'function') {
        await _doSaveCarouselPack(job.pdf_url, slides[0]?.png_url || null, slides.length, e.target);
        close();
      }
    });
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  async function ensureTemplateHtml(templateId) {
    if (tplHtml[templateId]) return;
    const r = await fetch(`/api/html-templates/${templateId}/html`, { credentials: 'include' });
    if (!r.ok) throw new Error('Could not load slide template');
    tplHtml[templateId] = await r.text();
  }

  async function open(packId) {
    scaffold();
    const rail = $('#cstudio-rail');
    rail.innerHTML = '<div style="font-size:12px;color:var(--text-muted,#6b7280);padding:8px">Loading…</div>';
    $('#cstudio-panel').innerHTML = '<div style="font-size:13px;color:var(--text-muted,#6b7280)">Building your carousel draft…</div>';

    try {
      const [packRes, draftRes] = await Promise.all([
        fetch(`/api/carousel-packs/${packId}`, { credentials: 'include' }),
        fetch(`/api/posts/${encodeURIComponent(String(currentPostId))}/carousel-draft`, {
          method: 'POST', headers: apiHeaders(), credentials: 'include',
          body: JSON.stringify({ pack_id: packId }),
        }),
      ]);
      const packData = await packRes.json();
      const draftData = await draftRes.json();
      if (!packData.ok) throw new Error(packData.error || 'Could not load pack');
      if (!draftData.ok) throw new Error(draftData.error || 'Could not create draft');

      pack = packData.pack;
      deck = draftData.draft.deck;

      // Draft may belong to a different pack (user switched) — recreate
      if (deck.pack_id !== pack.id) {
        const re = await fetch(`/api/posts/${encodeURIComponent(String(currentPostId))}/carousel-draft`, {
          method: 'POST', headers: apiHeaders(), credentials: 'include',
          body: JSON.stringify({ pack_id: packId, force: true }),
        });
        const reData = await re.json();
        if (!reData.ok) throw new Error(reData.error || 'Could not create draft');
        deck = reData.draft.deck;
      }

      tplById = {};
      for (const s of pack.slides) tplById[s.template_id] = s;
      for (const v of pack.variants || []) tplById[v.template_id] = v;

      $('#cstudio-title').textContent = `CAROUSEL STUDIO — ${pack.name.toUpperCase()}`;

      await Promise.all([...new Set(deck.slides.map(s => s.template_id))].map(ensureTemplateHtml));
      // Prefetch remaining templates (variants etc.) in the background
      Object.keys(tplById).forEach(id => ensureTemplateHtml(id).catch(() => {}));

      activeIdx = 0;
      saveState = 'saved'; updateSaveBadge();
      renderAll();
    } catch (err) {
      $('#cstudio-panel').innerHTML = `<div style="color:#dc2626;font-size:13px">${esc(err.message)}</div>`;
    }
  }

  window.CarouselStudio = { open, close };
})();

'use strict';

/**
 * make-it-yours.js — the 60-second "Make It Yours" pass (Authentic Client Engine, Phase 2).
 *
 * After a post loads in the editor, this fetches 2–3 spans (hook / punchline /
 * bridge) worth rewriting in the author's own words, and renders one card per
 * span below the editor toolbar. Applying a card does a verbatim string-replace
 * inside #post-body and lets the editor's own machinery (char count, backdrop,
 * autosave) react via a dispatched 'input' event — so this module never touches
 * the editor's internals.
 *
 * Self-contained: exposes window.MakeItYours.init(opts) and nothing else.
 * Fails silent — if the API returns no spans, the panel never appears.
 */
(function () {
  const API_SUGGEST = '/api/generate/make-it-yours';
  const API_RECORD  = '/api/generate/miy-edited';

  const SLOT_LABEL = { hook: 'Hook', punchline: 'Punchline', bridge: 'Transition' };

  let _postId = null;
  let _textarea = null;
  let _panel = null;
  let _spansEdited = 0;
  let _editChars = 0;
  let _voiceCtrls = [];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function headers() {
    // Match the app's auth convention if a helper exists; cookies are the default.
    return (typeof window.apiHeaders === 'function')
      ? window.apiHeaders()
      : { 'Content-Type': 'application/json' };
  }

  async function init({ postId, textareaId = 'post-body', containerId = 'miy-panel', enabled = true } = {}) {
    if (!enabled) return;
    _postId = postId;
    _textarea = document.getElementById(textareaId);
    _panel = document.getElementById(containerId);
    if (!_textarea || !_panel) return;

    const postText = (_textarea.value || '').trim();
    if (postText.length < 40) return;

    let spans = [];
    try {
      const res = await fetch(API_SUGGEST, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId, postText }),
      });
      const data = await res.json();
      spans = (data.ok && Array.isArray(data.spans)) ? data.spans : [];
    } catch { spans = []; }

    // Only keep spans that still match the current text verbatim (user may have
    // edited between load and this fetch resolving).
    spans = spans.filter(s => s.excerpt && _textarea.value.includes(s.excerpt));
    if (!spans.length) return;

    render(spans);
  }

  function render(spans) {
    _panel.innerHTML = '';
    _panel.hidden = false;

    const head = document.createElement('div');
    head.className = 'miy-head';
    head.innerHTML = `
      <div class="miy-head-text">
        <strong>Make it yours — 60 seconds</strong>
        <span>Rewrite these lines in your own words. Posts you touch outperform pure AI drafts — and it reads like you.</span>
      </div>
      <button type="button" class="miy-dismiss" aria-label="Dismiss">Skip all</button>`;
    head.querySelector('.miy-dismiss').addEventListener('click', () => teardown());
    _panel.appendChild(head);

    spans.forEach((span, i) => _panel.appendChild(buildCard(span, i)));
  }

  function buildCard(span, idx) {
    const card = document.createElement('div');
    card.className = 'miy-card';
    const slot = SLOT_LABEL[span.slot] || 'Line';
    card.innerHTML = `
      <div class="miy-card-slot">${esc(slot)}</div>
      <blockquote class="miy-excerpt">${esc(span.excerpt)}</blockquote>
      ${span.why ? `<p class="miy-why">${esc(span.why)}</p>` : ''}
      <div class="miy-input-row">
        <textarea class="miy-input" rows="2" placeholder="${esc(span.prompt || 'Say this in your own words…')}"></textarea>
        <button type="button" class="miy-mic" aria-label="Record" title="Speak your version">🎙</button>
      </div>
      <div class="miy-actions">
        <button type="button" class="miy-apply">Apply</button>
        <button type="button" class="miy-skip">Skip</button>
      </div>`;

    const input   = card.querySelector('.miy-input');
    const micBtn  = card.querySelector('.miy-mic');
    const applyBtn = card.querySelector('.miy-apply');
    const skipBtn  = card.querySelector('.miy-skip');

    // Reuse the app's voice recorder if present; otherwise hide the mic.
    if (typeof window.initVoiceInput === 'function') {
      try {
        const ctrl = window.initVoiceInput({ input, btn: micBtn });
        if (ctrl) _voiceCtrls.push(ctrl);
      } catch { micBtn.style.display = 'none'; }
    } else {
      micBtn.style.display = 'none';
    }

    applyBtn.addEventListener('click', () => {
      const replacement = (input.value || '').trim();
      if (!replacement) { input.focus(); return; }
      applySpan(span.excerpt, replacement, card);
    });
    skipBtn.addEventListener('click', () => collapse(card));

    return card;
  }

  function applySpan(excerpt, replacement, card) {
    const ta = _textarea;
    const idx = ta.value.indexOf(excerpt);
    if (idx === -1) { collapse(card, 'This line changed — skipped.'); return; }

    ta.value = ta.value.slice(0, idx) + replacement + ta.value.slice(idx + excerpt.length);
    // Let the editor react (char count, backdrop, autosave, autosize).
    ta.dispatchEvent(new Event('input', { bubbles: true }));

    _spansEdited += 1;
    _editChars += Math.abs(replacement.length - excerpt.length) + Math.min(replacement.length, excerpt.length);
    collapse(card, 'Applied — that\'s your voice.');
    recordProgress();

    // When every card is resolved, retire the panel shortly after.
    if (![..._panel.querySelectorAll('.miy-card')].some(c => !c.dataset.done)) {
      setTimeout(() => teardown(), 1200);
    }
  }

  function collapse(card, note) {
    card.dataset.done = '1';
    card.classList.add('miy-card--done');
    card.innerHTML = `<div class="miy-done-note">✓ ${esc(note || 'Skipped')}</div>`;
  }

  function recordProgress() {
    // Fire-and-forget; the UPDATE is idempotent (latest totals win).
    fetch(API_RECORD, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId: _postId, spansEdited: _spansEdited, humanEditChars: _editChars }),
    }).catch(() => {});
  }

  function teardown() {
    try { _voiceCtrls.forEach(c => c?.stop?.()); } catch {}
    _voiceCtrls = [];
    if (_panel) { _panel.hidden = true; _panel.innerHTML = ''; }
  }

  window.MakeItYours = { init };
})();

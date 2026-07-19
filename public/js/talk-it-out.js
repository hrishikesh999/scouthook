'use strict';

/**
 * talk-it-out.js — "Talk it out" voice capture (Authentic Client Engine, Phase 1.3).
 *
 * A founder speaks for ~60–90s; Web Speech transcribes locally (no audio leaves
 * the browser). We send the transcript to /api/generate/structure-brief, compose
 * a clean first-person brief from what was heard, and hand it to the interview
 * coach via window.startInterviewWithBrief() — reusing the entire existing
 * generate pipeline. Any leftover stories the founder mentioned are banked
 * server-side as vault ideas.
 *
 * Self-contained: builds its own modal on first open, reuses window.initVoiceInput
 * for the recorder. Trigger: a click on #talk-it-out-cta.
 */
(function () {
  const API = '/api/generate/structure-brief';
  let _modal = null;
  let _voiceCtrl = null;
  let _ta = null;

  function headers() {
    return (typeof window.apiHeaders === 'function')
      ? window.apiHeaders()
      : { 'Content-Type': 'application/json' };
  }

  function build() {
    const overlay = document.createElement('div');
    overlay.className = 'tio-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="tio-modal" role="dialog" aria-modal="true" aria-label="Talk it out">
        <button type="button" class="tio-close" aria-label="Close">×</button>
        <h2 class="tio-title">Talk it out</h2>
        <p class="tio-sub">Tell me what happened this week — a client win, a lesson, a moment that stuck. Speak like you'd tell a colleague. I'll shape it into a post.</p>
        <div class="tio-rec-row">
          <button type="button" class="tio-mic" id="tio-mic" aria-label="Start recording">🎙</button>
          <span class="tio-hint" id="tio-hint">Tap the mic and start talking</span>
        </div>
        <textarea id="tio-transcript" class="tio-transcript" rows="6" placeholder="…or type it here" aria-label="What you said"></textarea>
        <div class="tio-actions">
          <button type="button" class="tio-cancel">Cancel</button>
          <button type="button" class="tio-go" id="tio-go" disabled>Turn this into a post →</button>
        </div>
        <p class="tio-status" id="tio-status" hidden></p>
      </div>`;
    document.body.appendChild(overlay);

    _ta = overlay.querySelector('#tio-transcript');
    const micBtn = overlay.querySelector('#tio-mic');
    const goBtn  = overlay.querySelector('#tio-go');

    const refreshGo = () => { goBtn.disabled = (_ta.value.trim().length < 15); };
    _ta.addEventListener('input', refreshGo);

    if (typeof window.initVoiceInput === 'function') {
      try {
        _voiceCtrl = window.initVoiceInput({ input: _ta, btn: micBtn, onResult: refreshGo });
      } catch { /* mic optional — typing still works */ }
    } else {
      micBtn.style.display = 'none';
      overlay.querySelector('#tio-hint').textContent = 'Type what happened below';
    }

    overlay.querySelector('.tio-close').addEventListener('click', close);
    overlay.querySelector('.tio-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    goBtn.addEventListener('click', submit);

    return overlay;
  }

  function open() {
    if (document.getElementById('plan-gate-banner')) return;
    if (!_modal) _modal = build();
    _modal.hidden = false;
    setTimeout(() => _ta?.focus(), 50);
  }

  function close() {
    try { _voiceCtrl?.stop?.(); } catch {}
    if (_modal) _modal.hidden = true;
  }

  function composeBrief(f, transcript) {
    const parts = [];
    if (f.moment)        parts.push(f.moment);
    if (f.tension)       parts.push(f.tension);
    if (f.proof)         parts.push(`What happened: ${f.proof}`);
    if (f.audience_hook) parts.push(`Who this helps: ${f.audience_hook}`);
    const composed = parts.join('\n\n').trim();
    // Fall back to the raw transcript if structuring found nothing — the coach
    // will still ask the right questions.
    return composed || transcript;
  }

  async function submit() {
    const transcript = (_ta.value || '').trim();
    if (transcript.length < 15) return;
    try { _voiceCtrl?.stop?.(); } catch {}

    const status = _modal.querySelector('#tio-status');
    const goBtn  = _modal.querySelector('#tio-go');
    goBtn.disabled = true;
    if (status) { status.hidden = false; status.textContent = 'Listening back to what you said…'; }

    let data = {};
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript }),
      });
      data = await res.json();
    } catch { data = {}; }

    const brief = composeBrief(data || {}, transcript);

    if (data && data.leftover_count > 0 && status) {
      status.textContent = `Saved ${data.leftover_count} other idea${data.leftover_count > 1 ? 's' : ''} to your vault.`;
    }

    close();

    if (typeof window.startInterviewWithBrief === 'function') {
      window.startInterviewWithBrief(brief, '💬 From your voice note');
    }
  }

  document.getElementById('talk-it-out-cta')?.addEventListener('click', open);
  window.TalkItOut = { open };

  // Deep link: /generate.html?talk=1 (used by the dashboard entry card) opens
  // the capture modal on load.
  try {
    if (new URLSearchParams(window.location.search).get('talk') === '1') {
      setTimeout(open, 300);
    }
  } catch { /* no-op */ }
})();

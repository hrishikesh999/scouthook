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
  let _lastLine = '';

  // Captain Scout's opening lines — one is spoken + shown each time the modal opens.
  const CAPTAIN_OPENERS = [
    "Ahoy — Captain Scout here. Let's find your next post. Tell me: what's one thing from your work this week that stuck with you?",
    "Captain Scout, reporting in. Forget writing for a second — just talk. What happened recently that you'd tell a colleague about?",
    "Ahoy! Captain Scout at the helm. What's a win, a lesson, or a moment from this week worth sharing? Say it however it comes out.",
    "Captain Scout here. Every good post starts with a real story. What's yours this week — a client moment, a decision, a surprise?",
  ];

  function muted() {
    try { return localStorage.getItem('tio_captain_muted') === '1'; } catch { return false; }
  }
  function setMuted(v) {
    try { localStorage.setItem('tio_captain_muted', v ? '1' : '0'); } catch {}
  }

  // Browser-native TTS — no external service, CSP-safe. Picks a stable English
  // voice when available (voices load async, so we re-query at speak time).
  function pickVoice() {
    if (!('speechSynthesis' in window)) return null;
    const voices = window.speechSynthesis.getVoices() || [];
    if (!voices.length) return null;
    return voices.find(v => /en[-_]GB/i.test(v.lang)) // a touch more "Captain"
        || voices.find(v => /en[-_]US/i.test(v.lang))
        || voices.find(v => /^en/i.test(v.lang))
        || voices[0];
  }

  function speak(text) {
    if (muted() || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) u.voice = v;
      u.rate = 0.98; u.pitch = 0.95;
      // Invite the user to answer once the Captain finishes talking.
      u.onend = () => document.getElementById('tio-mic')?.classList.add('tio-mic--invite');
      window.speechSynthesis.speak(u);
    } catch { /* speech is best-effort */ }
  }

  function captainAsk(line) {
    _lastLine = line;
    const says = document.getElementById('tio-captain-says');
    if (says) says.textContent = line;
    document.getElementById('tio-mic')?.classList.remove('tio-mic--invite');
    speak(line);
  }

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
      <div class="tio-modal" role="dialog" aria-modal="true" aria-label="Talk it out with Captain Scout">
        <button type="button" class="tio-close" aria-label="Close">×</button>

        <div class="tio-captain">
          <div class="tio-captain-avatar" aria-hidden="true">🧭</div>
          <div class="tio-captain-bubble">
            <div class="tio-captain-name">
              Captain Scout
              <span class="tio-captain-tools">
                <button type="button" class="tio-captain-btn" id="tio-replay" aria-label="Replay" title="Hear it again">🔊</button>
                <button type="button" class="tio-captain-btn" id="tio-mute" aria-label="Mute Captain Scout" title="Mute">🔈</button>
              </span>
            </div>
            <p class="tio-captain-says" id="tio-captain-says" aria-live="polite">…</p>
          </div>
        </div>

        <div class="tio-rec-row">
          <button type="button" class="tio-mic" id="tio-mic" aria-label="Start recording">🎙</button>
          <span class="tio-hint" id="tio-hint">Tap the mic and answer the Captain</span>
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
    // Stop the "answer me" pulse once the user engages the mic.
    micBtn.addEventListener('click', () => micBtn.classList.remove('tio-mic--invite'));

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

    // Captain Scout controls
    const replayBtn = overlay.querySelector('#tio-replay');
    const muteBtn   = overlay.querySelector('#tio-mute');
    const syncMuteBtn = () => {
      muteBtn.textContent = muted() ? '🔇' : '🔈';
      muteBtn.setAttribute('aria-label', muted() ? 'Unmute Captain Scout' : 'Mute Captain Scout');
      muteBtn.classList.toggle('active', muted());
    };
    syncMuteBtn();
    replayBtn.addEventListener('click', () => { if (_lastLine) speak(_lastLine); });
    muteBtn.addEventListener('click', () => {
      const nowMuted = !muted();
      setMuted(nowMuted);
      syncMuteBtn();
      if (nowMuted) { try { window.speechSynthesis?.cancel(); } catch {} }
      else if (_lastLine) speak(_lastLine);
    });

    return overlay;
  }

  function open() {
    if (document.getElementById('plan-gate-banner')) return;
    if (!_modal) _modal = build();
    _modal.hidden = false;
    // Captain Scout greets and asks the first question (spoken + shown). The
    // short delay lets the modal paint and gives TTS voices a beat to load.
    const line = CAPTAIN_OPENERS[Math.floor(Math.random() * CAPTAIN_OPENERS.length)];
    setTimeout(() => captainAsk(line), 120);
    setTimeout(() => _ta?.focus(), 60);
  }

  function close() {
    try { _voiceCtrl?.stop?.(); } catch {}
    try { window.speechSynthesis?.cancel(); } catch {}
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

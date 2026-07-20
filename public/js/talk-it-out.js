'use strict';

/**
 * talk-it-out.js — "Talk it out" with Captain Scout (Authentic Client Engine).
 *
 * Captain Scout is a voice-guided host who INTERVIEWS the founder inside the
 * modal: he speaks an opener, listens (Web Speech, local — no audio leaves the
 * browser), then asks up to a few intelligent counter-questions grounded in the
 * user's voice profile + audience via /api/generate/chat-intake (the same
 * adaptive endpoint the on-page coach uses — it scores moment/proof/tension/
 * audience and returns the single most useful follow-up). When the brief is
 * strong enough (or the user taps "Just write it"), Captain composes a
 * provenance-labelled interview payload and hands it straight to generation.
 *
 * Self-contained: builds its own modal, reuses window.initVoiceInput for the
 * recorder and window.startGenerationFromInterview to generate. TTS is
 * browser-native (CSP-safe) and degrades to text-only if unavailable/muted.
 */
(function () {
  const INTAKE_API   = '/api/generate/chat-intake';
  const STRUCTURE_API = '/api/generate/structure-brief'; // used only to bank leftover stories
  const POST_TYPE    = 'reach';   // narrative archetype; matches the interview front door
  const MAX_FOLLOWUPS = 3;

  let _modal = null;
  let _voiceCtrl = null;
  let _ta = null;
  let _lastLine = '';

  // Interview state (reset each open)
  let _phase = 'opener';      // 'opener' | 'followup' | 'done'
  let _brief = '';            // the first answer — the seed / initialInput
  let _history = [];          // chat-intake history: [{role:'user'|'coach', content}]
  let _exchanges = [];        // assembleBrief exchanges: [{question, gap, answer, from_skip_suggestion}]
  let _count = 0;             // follow-ups answered
  let _pendingQ = null, _pendingGap = null;

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

  function pickVoice() {
    if (!('speechSynthesis' in window)) return null;
    const voices = window.speechSynthesis.getVoices() || [];
    if (!voices.length) return null;
    return voices.find(v => /en[-_]GB/i.test(v.lang))
        || voices.find(v => /en[-_]US/i.test(v.lang))
        || voices.find(v => /^en/i.test(v.lang))
        || voices[0];
  }

  // Returns true if speech actually started (so callers can fall back to a
  // visual cue when TTS is muted/unavailable).
  function speak(text) {
    if (muted() || !('speechSynthesis' in window)) return false;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) u.voice = v;
      u.rate = 0.98; u.pitch = 0.95;
      u.onend = () => document.getElementById('tio-mic')?.classList.add('tio-mic--invite');
      window.speechSynthesis.speak(u);
      return true;
    } catch { return false; }
  }

  function captainAsk(line) {
    _lastLine = line;
    const says = document.getElementById('tio-captain-says');
    if (says) says.textContent = line;
    const mic = document.getElementById('tio-mic');
    mic?.classList.remove('tio-mic--invite');
    // If the Captain can't speak (muted/unsupported), invite the answer immediately.
    if (!speak(line)) mic?.classList.add('tio-mic--invite');
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
        <textarea id="tio-transcript" class="tio-transcript" rows="4" placeholder="…or type your answer here" aria-label="Your answer"></textarea>
        <div class="tio-actions">
          <button type="button" class="tio-cancel">Cancel</button>
          <button type="button" class="tio-skip" id="tio-skip">Just write it →</button>
          <button type="button" class="tio-go" id="tio-go" disabled>Answer →</button>
        </div>
        <p class="tio-status" id="tio-status" hidden></p>
      </div>`;
    document.body.appendChild(overlay);

    _ta = overlay.querySelector('#tio-transcript');
    const micBtn = overlay.querySelector('#tio-mic');
    const goBtn  = overlay.querySelector('#tio-go');

    const refreshGo = () => { goBtn.disabled = (_ta.value.trim().length < 2 || _phase === 'done'); };
    _ta.addEventListener('input', refreshGo);
    micBtn.addEventListener('click', () => micBtn.classList.remove('tio-mic--invite'));

    if (typeof window.initVoiceInput === 'function') {
      try {
        _voiceCtrl = window.initVoiceInput({ input: _ta, btn: micBtn, onResult: refreshGo });
      } catch { /* mic optional — typing still works */ }
    } else {
      micBtn.style.display = 'none';
      overlay.querySelector('#tio-hint').textContent = 'Type your answer below';
    }

    overlay.querySelector('.tio-close').addEventListener('click', close);
    overlay.querySelector('.tio-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    goBtn.addEventListener('click', submitAnswer);
    overlay.querySelector('#tio-skip').addEventListener('click', finishInterview);

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

  function resetState() {
    _phase = 'opener'; _brief = ''; _history = []; _exchanges = [];
    _count = 0; _pendingQ = null; _pendingGap = null;
    if (_ta) _ta.value = '';
  }

  function setStatus(msg) {
    const s = document.getElementById('tio-status');
    if (!s) return;
    if (msg) { s.hidden = false; s.textContent = msg; } else { s.hidden = true; s.textContent = ''; }
  }

  function setBusy(busy) {
    const go = document.getElementById('tio-go');
    const skip = document.getElementById('tio-skip');
    if (go) go.disabled = busy || (_ta.value.trim().length < 2);
    if (skip) skip.disabled = busy;
  }

  function stopRecording() { try { _voiceCtrl?.stop?.(); } catch {} }

  function open() {
    if (document.getElementById('plan-gate-banner')) return;
    if (!_modal) _modal = build();
    resetState();
    _modal.hidden = false;
    const line = CAPTAIN_OPENERS[Math.floor(Math.random() * CAPTAIN_OPENERS.length)];
    setStatus('');
    setTimeout(() => captainAsk(line), 120);
    setTimeout(() => _ta?.focus(), 60);
  }

  function close() {
    stopRecording();
    try { window.speechSynthesis?.cancel(); } catch {}
    if (_modal) _modal.hidden = true;
  }

  // User answered the current question — record it, then let Captain decide the
  // next move via chat-intake.
  function submitAnswer() {
    const answer = (_ta.value || '').trim();
    if (answer.length < 2 || _phase === 'done') return;
    stopRecording();

    if (_phase === 'opener') {
      _brief = answer;
      _history = [{ role: 'user', content: answer }];
    } else {
      if (_pendingQ) _exchanges.push({ question: _pendingQ, gap: _pendingGap, answer, from_skip_suggestion: false });
      _history.push({ role: 'user', content: answer });
      _count++;
    }
    _ta.value = '';
    askIntake();
  }

  async function askIntake() {
    setBusy(true);
    setStatus('Captain Scout is thinking…');

    let data = { ready: true };
    try {
      const res = await fetch(INTAKE_API, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: _brief, history: _history, post_type: POST_TYPE, exchange_count: _count }),
      });
      data = await res.json();
    } catch { data = { ready: true }; }

    setStatus('');
    setBusy(false);

    if (data.ready || _count >= MAX_FOLLOWUPS || !data.question) {
      finishInterview();
      return;
    }
    _pendingQ = data.question;
    _pendingGap = data.gap || null;
    _history.push({ role: 'coach', content: _pendingQ });
    _phase = 'followup';
    const hint = document.getElementById('tio-hint');
    if (hint) hint.textContent = 'Answer the Captain — or tap "Just write it" anytime';
    captainAsk(_pendingQ);
  }

  // Compose the interview payload from whatever's captured (plus any un-sent text
  // in the box) and hand straight to generation.
  function finishInterview() {
    if (_phase === 'done') return;
    const pending = (_ta.value || '').trim();
    if (_phase === 'opener') {
      if (pending) _brief = pending;
    } else if (pending && _pendingQ) {
      _exchanges.push({ question: _pendingQ, gap: _pendingGap, answer: pending, from_skip_suggestion: false });
    }
    if (!_brief && !_exchanges.length) { toast('Tell the Captain a bit first'); return; }
    generate();
  }

  function generate() {
    _phase = 'done';
    stopRecording();
    bankLeftovers(); // fire-and-forget: mine any extra stories into the vault

    const initialInput = _brief;
    const exchanges = _exchanges.slice();

    captainAsk('Aye — writing your post now.');
    setStatus('Charting your post…');

    setTimeout(() => {
      close();
      if (typeof window.startGenerationFromInterview === 'function') {
        window.startGenerationFromInterview(initialInput, exchanges, POST_TYPE);
      } else if (typeof window.startInterviewWithBrief === 'function') {
        window.startInterviewWithBrief(composeFallbackBrief(initialInput, exchanges), '💬 Captain Scout');
      }
    }, 500);
  }

  // Bank extra stories the founder mentioned (server dedupes / guards). Best-effort.
  function bankLeftovers() {
    const transcript = [_brief, ..._exchanges.map(e => e.answer)].filter(Boolean).join('\n\n');
    if (transcript.trim().length < 40) return;
    fetch(STRUCTURE_API, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript }),
    }).catch(() => {});
  }

  // Fallback only if startGenerationFromInterview isn't present: a readable brief
  // for the on-page coach.
  function composeFallbackBrief(initialInput, exchanges) {
    const parts = [initialInput];
    for (const e of exchanges) if (e.answer) parts.push(e.answer);
    return parts.filter(Boolean).join('\n\n');
  }

  function toast(msg) { if (window.toast) window.toast(msg); }

  document.getElementById('talk-it-out-cta')?.addEventListener('click', open);
  window.TalkItOut = { open };

  // Deep link: /generate.html?talk=1 (dashboard entry card) opens the modal.
  try {
    if (new URLSearchParams(window.location.search).get('talk') === '1') {
      setTimeout(open, 300);
    }
  } catch { /* no-op */ }
})();

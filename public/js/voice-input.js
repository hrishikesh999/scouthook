'use strict';

/**
 * Attaches a Web Speech API voice recorder to a textarea.
 *
 * Improvements over v1:
 *  - getUserMedia() pre-flight on first click: shows a clean browser permission
 *    dialog and catches denial before recognition ever starts.
 *  - Permissions API state watch: marks button as blocked immediately on load
 *    if the user previously denied microphone access.
 *  - Visible tooltip + button visual for permission-denied state so users know
 *    exactly why the mic isn't working and how to fix it.
 *  - Graceful error handling for all SpeechRecognition error codes.
 *  - try/catch around recognition.start() / .stop() to guard against
 *    "already started / not started" InvalidStateError throws.
 *
 * @param {object} opts
 * @param {HTMLTextAreaElement} opts.input    - The textarea to fill
 * @param {HTMLButtonElement}   opts.btn      - The mic button to control
 * @param {() => boolean}       [opts.guard]  - Return true to block recording start
 * @param {() => void}          [opts.onResult] - Called after each speech result
 */
function initVoiceInput({ input, btn, guard, onResult } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !input || !btn) return;

  btn.style.display = 'flex';

  const recognition      = new SR();
  recognition.continuous     = true;
  recognition.interimResults = true;
  recognition.lang           = 'en-US';

  let recording  = false;
  let permDenied = false;
  let committedText = '';

  // ── Permission tooltip ─────────────────────────────────────────
  let _tip = null;
  function showPermTip(msg) {
    if (_tip) return;
    // Ensure the button's parent has position:relative so the tooltip anchors correctly
    const parent = btn.parentElement;
    if (parent && getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
    _tip = document.createElement('div');
    _tip.className = 'voice-perm-tip';
    _tip.textContent = msg || 'Microphone blocked. Click the 🔒 in your browser\'s address bar to allow access.';
    btn.insertAdjacentElement('beforebegin', _tip);
    setTimeout(() => { _tip?.remove(); _tip = null; }, 6000);
  }

  function setPermDenied(denied) {
    permDenied = denied;
    btn.classList.toggle('mic-perm-denied', denied);
    btn.title = denied
      ? 'Microphone blocked — click the 🔒 in your browser\'s address bar to allow'
      : '';
  }

  // ── Check permission state on init (non-blocking) ─────────────
  if (navigator.permissions?.query) {
    navigator.permissions.query({ name: 'microphone' }).then(status => {
      if (status.state === 'denied') setPermDenied(true);
      // Reactively update if the user changes the setting in the browser
      status.addEventListener('change', () => {
        setPermDenied(status.state === 'denied');
      });
    }).catch(() => {}); // Permissions API may not support 'microphone' in all browsers
  }

  // ── start / stop ───────────────────────────────────────────────
  async function start() {
    if (permDenied) {
      showPermTip();
      return;
    }

    // getUserMedia pre-flight:
    // 1. Triggers the browser's permission dialog on first use.
    // 2. Catches an existing "denied" state cleanly before recognition starts.
    // 3. We immediately stop the stream — Web Speech API manages its own capture.
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
      } catch (err) {
        const denied = err.name === 'NotAllowedError'
                    || err.name === 'PermissionDeniedError'
                    || err.name === 'SecurityError';
        if (denied) {
          setPermDenied(true);
          showPermTip();
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          showPermTip('No microphone found. Connect one and try again.');
        } else {
          showPermTip('Could not access microphone. Check your browser settings.');
        }
        return;
      }
    }

    committedText = input.value;
    recording     = true;
    btn.classList.add('recording');
    btn.setAttribute('aria-label', 'Stop recording');
    try {
      recognition.start();
    } catch {
      // InvalidStateError — recognition already running; treat as a no-op
      stop();
    }
  }

  function stop() {
    recording = false;
    btn.classList.remove('recording');
    btn.setAttribute('aria-label', 'Record voice input');
    try { recognition.stop(); } catch {} // ignore if already stopped
  }

  // ── Handlers ───────────────────────────────────────────────────
  recognition.onresult = (e) => {
    let interim   = '';
    let committed = committedText;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      e.results[i].isFinal ? (committed += t + ' ') : (interim = t);
    }
    committedText = committed;
    input.value   = committed + interim;
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
    if (onResult) onResult();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  recognition.onerror = (e) => {
    switch (e.error) {
      case 'no-speech':
      case 'aborted':
        // Non-fatal — recognition auto-restarts via onend
        return;

      case 'not-allowed':
      case 'service-not-allowed':
        setPermDenied(true);
        stop();
        showPermTip();
        return;

      case 'audio-capture':
        stop();
        showPermTip('No microphone detected. Check that one is connected and not in use by another app.');
        return;

      case 'network':
        stop();
        showPermTip('Network error during speech recognition. Check your connection and try again.');
        return;

      default:
        stop();
    }
  };

  // Keep recognition alive while recording flag is set
  recognition.onend = () => {
    if (!recording) return;
    try { recognition.start(); } catch {}
  };

  btn.addEventListener('click', () => {
    if (guard && guard()) return;
    recording ? stop() : start();
  });

  return { stop };
}

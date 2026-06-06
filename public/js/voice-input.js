'use strict';

/**
 * Attaches a Web Speech API voice recorder to a textarea.
 * The mic button is shown only when SpeechRecognition is available.
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

  let recording     = false;
  let committedText = '';

  function start() {
    committedText = input.value;
    recording     = true;
    btn.classList.add('recording');
    btn.setAttribute('aria-label', 'Stop recording');
    recognition.start();
  }

  function stop() {
    recording = false;
    btn.classList.remove('recording');
    btn.setAttribute('aria-label', 'Record voice input');
    recognition.stop();
  }

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
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    stop();
  };

  recognition.onend = () => { if (recording) recognition.start(); };

  btn.addEventListener('click', () => {
    if (guard && guard()) return;
    recording ? stop() : start();
  });

  return { stop };
}

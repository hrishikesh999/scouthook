'use strict';

/**
 * format-reco.js — dwell-time format nudge (Authentic Client Engine, Phase 3).
 *
 * Renders a single dismissible chip in the editor when the server recommends a
 * richer format than plain text for the current post. Accepting it clicks the
 * editor's existing visual-action-bar control (carousel or media) — no new
 * handoff pipeline — and logs the choice so Phase 4 can validate the recommender.
 *
 * Self-contained: window.FormatReco.init({ postId, reco }).
 */
(function () {
  const API_LOG = '/api/generate/format-reco';

  function headers() {
    return (typeof window.apiHeaders === 'function')
      ? window.apiHeaders()
      : { 'Content-Type': 'application/json' };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function log(postId, format, action) {
    fetch(API_LOG, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId, format, action }),
    }).catch(() => {});
  }

  function init({ postId, reco, containerId = 'format-reco-chip' } = {}) {
    const panel = document.getElementById(containerId);
    if (!panel || !reco || !reco.format || reco.format === 'text') return;

    const cta = reco.format === 'carousel' ? 'Make it a carousel' : 'Add a visual';
    panel.innerHTML = `
      <span class="freco-icon">💡</span>
      <span class="freco-text">${esc(reco.reason || '')}</span>
      <button type="button" class="freco-accept">${esc(cta)} →</button>
      <button type="button" class="freco-dismiss" aria-label="Dismiss">×</button>`;
    panel.hidden = false;

    panel.querySelector('.freco-accept').addEventListener('click', () => {
      log(postId, reco.format, 'accepted');
      // Reuse the editor's own controls — no bespoke handoff.
      const targetId = reco.format === 'carousel' ? 'vab-carousel-btn' : 'vab-media-btn';
      document.getElementById(targetId)?.click();
      panel.hidden = true;
    });
    panel.querySelector('.freco-dismiss').addEventListener('click', () => {
      log(postId, reco.format, 'dismissed');
      panel.hidden = true;
    });
  }

  window.FormatReco = { init };
})();

/* feedback-widget.js — Floating feedback button + modal for ScoutHook
 * Exposes window.FeedbackWidget = { open, close }
 * Loaded on all protected pages via account-bar.js
 */
(function () {
  'use strict';

  // ── Inject styles ───────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
  #fb-btn {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 800;
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--bg-surface, #fff);
    border: 1px solid var(--border, #E4E4E7);
    border-radius: 20px;
    padding: 8px 14px 8px 10px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted, #71717A);
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,0.10);
    transition: box-shadow 0.15s, color 0.15s;
    font-family: inherit;
  }
  #fb-btn:hover {
    box-shadow: 0 4px 16px rgba(0,0,0,0.14);
    color: var(--text-heading, #09090B);
  }

  #fb-overlay {
    position: fixed;
    inset: 0;
    z-index: 900;
    background: rgba(9,9,11,0.5);
    display: none;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  #fb-overlay.visible { display: flex; }

  #fb-modal {
    background: var(--bg-surface, #fff);
    border: 1px solid var(--border, #E4E4E7);
    border-radius: 16px;
    width: 100%;
    max-width: 440px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.18);
    position: relative;
    padding: 32px 32px 28px;
  }

  #fb-close {
    position: absolute;
    top: 12px; right: 12px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted, #71717A);
    padding: 4px;
    border-radius: 6px;
    line-height: 1;
    display: flex;
    align-items: center;
  }
  #fb-close:hover { background: var(--bg-pill, #F4F4F5); }

  #fb-modal h2 {
    font-size: 17px;
    font-weight: 700;
    color: var(--text-heading, #09090B);
    margin: 0 0 4px;
  }
  #fb-modal .fb-sub {
    font-size: 13px;
    color: var(--text-muted, #71717A);
    margin: 0 0 20px;
  }

  .fb-stars {
    display: flex;
    gap: 4px;
    margin-bottom: 16px;
  }
  .fb-star {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 24px;
    padding: 2px;
    line-height: 1;
    color: #D4D4D8;
    transition: color 0.1s, transform 0.1s;
  }
  .fb-star:hover,
  .fb-star.active { color: #F59E0B; }
  .fb-star:hover { transform: scale(1.15); }

  #fb-message {
    width: 100%;
    box-sizing: border-box;
    min-height: 100px;
    resize: vertical;
    border: 1px solid var(--border, #E4E4E7);
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 14px;
    color: var(--text-heading, #09090B);
    font-family: inherit;
    background: var(--bg-surface, #fff);
    outline: none;
    transition: border-color 0.15s;
    margin-bottom: 16px;
  }
  #fb-message:focus { border-color: var(--brand, #0F766E); }
  #fb-message::placeholder { color: var(--text-muted, #71717A); }

  .fb-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  #fb-cancel {
    background: none;
    border: 1px solid var(--border, #E4E4E7);
    border-radius: 8px;
    padding: 8px 16px;
    font-size: 14px;
    font-weight: 500;
    color: var(--text-muted, #71717A);
    cursor: pointer;
    font-family: inherit;
  }
  #fb-cancel:hover { background: var(--bg-pill, #F4F4F5); }
  #fb-submit {
    background: var(--brand, #0F766E);
    border: none;
    border-radius: 8px;
    padding: 8px 18px;
    font-size: 14px;
    font-weight: 600;
    color: #fff;
    cursor: pointer;
    font-family: inherit;
    transition: opacity 0.15s;
  }
  #fb-submit:hover { opacity: 0.88; }
  #fb-submit:disabled { opacity: 0.5; cursor: default; }
  `;
  document.head.appendChild(style);

  // ── Inject HTML ─────────────────────────────────────────────────────────────
  const floatBtn = document.createElement('button');
  floatBtn.id = 'fb-btn';
  floatBtn.setAttribute('aria-label', 'Share feedback');
  floatBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    Feedback
  `;

  const overlay = document.createElement('div');
  overlay.id = 'fb-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Share feedback');
  overlay.innerHTML = `
    <div id="fb-modal">
      <button id="fb-close" aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <h2>Share feedback</h2>
      <p class="fb-sub">What's working well, or what would you improve?</p>
      <div class="fb-stars" role="group" aria-label="Rating (optional)">
        <button class="fb-star" data-value="1" aria-label="1 star">★</button>
        <button class="fb-star" data-value="2" aria-label="2 stars">★</button>
        <button class="fb-star" data-value="3" aria-label="3 stars">★</button>
        <button class="fb-star" data-value="4" aria-label="4 stars">★</button>
        <button class="fb-star" data-value="5" aria-label="5 stars">★</button>
      </div>
      <textarea id="fb-message" placeholder="Your feedback…" maxlength="2000"></textarea>
      <div class="fb-actions">
        <button id="fb-cancel">Cancel</button>
        <button id="fb-submit">Send feedback</button>
      </div>
    </div>
  `;

  document.body.appendChild(floatBtn);
  document.body.appendChild(overlay);

  // ── State ───────────────────────────────────────────────────────────────────
  let selectedRating = null;

  // ── Star rating ─────────────────────────────────────────────────────────────
  const stars = overlay.querySelectorAll('.fb-star');
  stars.forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = parseInt(btn.dataset.value, 10);
      selectedRating = (selectedRating === val) ? null : val;
      updateStars();
    });
  });

  function updateStars() {
    stars.forEach((btn) => {
      btn.classList.toggle('active', selectedRating !== null && parseInt(btn.dataset.value, 10) <= selectedRating);
    });
  }

  // ── Open / Close ─────────────────────────────────────────────────────────────
  function open() {
    overlay.classList.add('visible');
    overlay.querySelector('#fb-message').focus();
  }

  function close() {
    overlay.classList.remove('visible');
    overlay.querySelector('#fb-message').value = '';
    selectedRating = null;
    updateStars();
    overlay.querySelector('#fb-submit').disabled = false;
  }

  floatBtn.addEventListener('click', open);
  overlay.querySelector('#fb-close').addEventListener('click', close);
  overlay.querySelector('#fb-cancel').addEventListener('click', close);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('visible')) close();
  });

  // ── Submit ───────────────────────────────────────────────────────────────────
  overlay.querySelector('#fb-submit').addEventListener('click', async () => {
    const message = overlay.querySelector('#fb-message').value.trim();
    if (!message) {
      overlay.querySelector('#fb-message').focus();
      return;
    }

    const btn = overlay.querySelector('#fb-submit');
    btn.disabled = true;
    btn.textContent = 'Sending…';

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, rating: selectedRating, page_url: location.href }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'request failed');
      }

      close();
      window.toast?.success('Thanks for your feedback!');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Send feedback';
      window.toast?.error('Could not send feedback — please try again.');
    }
  });

  window.FeedbackWidget = { open, close };
})();

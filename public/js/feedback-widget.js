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
    right: 0;
    top: 50%;
    transform-origin: right top;
    transform: rotate(90deg) translateX(50%);
    z-index: 800;
    display: flex;
    align-items: center;
    gap: 6px;
    background: #6366F1;
    border: none;
    border-radius: 0 0 8px 8px;
    padding: 10px 14px 10px 12px;
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    cursor: pointer;
    box-shadow: -4px 0 16px rgba(99,102,241,0.30);
    transition: box-shadow 0.15s, background 0.15s;
    font-family: inherit;
    white-space: nowrap;
  }
  #fb-btn:hover {
    background: #4F46E5;
    box-shadow: -6px 0 20px rgba(99,102,241,0.45);
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
    max-width: 480px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.18);
    position: relative;
    padding: 28px 28px 24px;
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

  .fb-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 18px;
    padding-right: 28px;
  }
  .fb-header-icon {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #6366F1;
    flex-shrink: 0;
  }
  #fb-modal h2 {
    font-size: 17px;
    font-weight: 700;
    color: var(--text-heading, #09090B);
    margin: 0;
  }

  .fb-cats {
    display: flex;
    gap: 8px;
    margin-bottom: 18px;
    flex-wrap: wrap;
  }
  .fb-cat {
    background: none;
    border: 1px solid var(--border, #E4E4E7);
    border-radius: 20px;
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted, #71717A);
    cursor: pointer;
    font-family: inherit;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .fb-cat:hover {
    background: #EEF2FF;
    color: #4F46E5;
    border-color: #A5B4FC;
  }
  .fb-cat.active {
    background: #EEF2FF;
    color: #4F46E5;
    border-color: #4F46E5;
    font-weight: 600;
  }

  .fb-label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-heading, #09090B);
    margin-bottom: 6px;
  }

  #fb-title {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--border, #E4E4E7);
    border-radius: 8px;
    padding: 9px 12px;
    font-size: 14px;
    color: var(--text-heading, #09090B);
    font-family: inherit;
    background: var(--bg-surface, #fff);
    outline: none;
    transition: border-color 0.15s;
    margin-bottom: 14px;
  }
  #fb-title:focus { border-color: #6366F1; }
  #fb-title::placeholder { color: var(--text-muted, #71717A); }

  .fb-textarea-wrap {
    position: relative;
    margin-bottom: 16px;
  }
  #fb-message {
    width: 100%;
    box-sizing: border-box;
    min-height: 96px;
    resize: vertical;
    border: 1px solid var(--border, #E4E4E7);
    border-radius: 8px;
    padding: 10px 12px 28px 12px;
    font-size: 14px;
    color: var(--text-heading, #09090B);
    font-family: inherit;
    background: var(--bg-surface, #fff);
    outline: none;
    transition: border-color 0.15s;
    display: block;
  }
  #fb-message:focus { border-color: #6366F1; }
  #fb-message::placeholder { color: var(--text-muted, #71717A); }
  .fb-mic-icon {
    position: absolute;
    bottom: 10px;
    right: 10px;
    color: #A1A1AA;
    pointer-events: none;
    line-height: 1;
  }

  /* Attachment row */
  .fb-attach-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .fb-attach-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: none;
    border: 1px dashed var(--border, #E4E4E7);
    border-radius: 8px;
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted, #71717A);
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.12s, color 0.12s;
  }
  .fb-attach-btn:hover { border-color: #6366F1; color: #4F46E5; }
  .fb-attach-preview {
    display: none;
    align-items: center;
    gap: 8px;
  }
  .fb-attach-preview.visible { display: flex; }
  .fb-attach-thumb {
    width: 40px;
    height: 40px;
    object-fit: cover;
    border-radius: 6px;
    border: 1px solid var(--border, #E4E4E7);
  }
  .fb-attach-name {
    font-size: 12px;
    color: var(--text-muted, #71717A);
    max-width: 140px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fb-attach-remove {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted, #71717A);
    padding: 2px 4px;
    border-radius: 4px;
    line-height: 1;
    font-size: 14px;
  }
  .fb-attach-remove:hover { color: #ef4444; background: #fef2f2; }
  .fb-attach-uploading {
    font-size: 12px;
    color: var(--text-muted, #71717A);
    font-style: italic;
    display: none;
  }
  .fb-attach-uploading.visible { display: block; }
  .fb-attach-error {
    font-size: 12px;
    color: #ef4444;
    display: none;
  }
  .fb-attach-error.visible { display: block; }

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
    background: #6366F1;
    border: none;
    border-radius: 8px;
    padding: 8px 18px;
    font-size: 14px;
    font-weight: 600;
    color: #fff;
    cursor: pointer;
    font-family: inherit;
    transition: opacity 0.15s, background 0.15s;
  }
  #fb-submit:hover { background: #4F46E5; }
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
  overlay.setAttribute('aria-label', 'Submit feedback');
  overlay.innerHTML = `
    <div id="fb-modal">
      <button id="fb-close" aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="fb-header">
        <span class="fb-header-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </span>
        <h2>Submit Feedback</h2>
      </div>
      <div class="fb-cats" role="group" aria-label="Category">
        <button class="fb-cat active" data-cat="feature_request">Feature Request</button>
        <button class="fb-cat" data-cat="bug_report">Bug Report</button>
        <button class="fb-cat" data-cat="improvement">Improvement</button>
      </div>
      <label class="fb-label" for="fb-title">Title</label>
      <input id="fb-title" type="text" placeholder="Short summary of your feedback" maxlength="120" />
      <label class="fb-label" for="fb-message">Description</label>
      <div class="fb-textarea-wrap">
        <textarea id="fb-message" placeholder="Tell us more about your idea or issue…" maxlength="2000"></textarea>
        <span class="fb-mic-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
        </span>
      </div>
      <div class="fb-attach-row">
        <button type="button" class="fb-attach-btn" id="fb-attach-btn">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          Attach image
        </button>
        <span class="fb-attach-uploading" id="fb-attach-uploading">Uploading…</span>
        <span class="fb-attach-error" id="fb-attach-error"></span>
        <div class="fb-attach-preview" id="fb-attach-preview">
          <img class="fb-attach-thumb" id="fb-attach-thumb" src="" alt="Attachment preview" />
          <span class="fb-attach-name" id="fb-attach-name"></span>
          <button type="button" class="fb-attach-remove" id="fb-attach-remove" aria-label="Remove attachment">✕</button>
        </div>
        <input type="file" id="fb-attach-input" accept="image/jpeg,image/png,image/gif,image/webp" style="display:none" />
      </div>
      <div class="fb-actions">
        <button id="fb-cancel">Cancel</button>
        <button id="fb-submit">Submit Feedback</button>
      </div>
    </div>
  `;

  document.body.appendChild(floatBtn);
  document.body.appendChild(overlay);

  // ── State ───────────────────────────────────────────────────────────────────
  let selectedCategory = 'feature_request';
  let attachmentUrl    = null;   // set after successful upload
  let uploading        = false;

  // ── Category tabs ────────────────────────────────────────────────────────────
  const catBtns = overlay.querySelectorAll('.fb-cat');
  catBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedCategory = btn.dataset.cat;
      catBtns.forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  // ── Open / Close ─────────────────────────────────────────────────────────────
  function open() {
    overlay.classList.add('visible');
    overlay.querySelector('#fb-title').focus();
  }

  function clearAttachment() {
    attachmentUrl = null;
    uploading     = false;
    overlay.querySelector('#fb-attach-preview').classList.remove('visible');
    overlay.querySelector('#fb-attach-uploading').classList.remove('visible');
    overlay.querySelector('#fb-attach-error').classList.remove('visible');
    overlay.querySelector('#fb-attach-input').value = '';
    overlay.querySelector('#fb-attach-thumb').src = '';
    overlay.querySelector('#fb-attach-name').textContent = '';
  }

  function close() {
    overlay.classList.remove('visible');
    overlay.querySelector('#fb-title').value = '';
    overlay.querySelector('#fb-message').value = '';
    selectedCategory = 'feature_request';
    catBtns.forEach((b) => b.classList.toggle('active', b.dataset.cat === 'feature_request'));
    overlay.querySelector('#fb-submit').disabled = false;
    overlay.querySelector('#fb-submit').textContent = 'Submit Feedback';
    clearAttachment();
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

  // ── Attachment ───────────────────────────────────────────────────────────────
  overlay.querySelector('#fb-attach-btn').addEventListener('click', () => {
    overlay.querySelector('#fb-attach-input').click();
  });

  overlay.querySelector('#fb-attach-remove').addEventListener('click', clearAttachment);

  overlay.querySelector('#fb-attach-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const errorEl     = overlay.querySelector('#fb-attach-error');
    const uploadingEl = overlay.querySelector('#fb-attach-uploading');
    const previewEl   = overlay.querySelector('#fb-attach-preview');
    const thumbEl     = overlay.querySelector('#fb-attach-thumb');
    const nameEl      = overlay.querySelector('#fb-attach-name');

    clearAttachment();

    if (file.size > 5 * 1024 * 1024) {
      errorEl.textContent = 'Image must be under 5 MB.';
      errorEl.classList.add('visible');
      return;
    }

    // Show local preview immediately
    thumbEl.src = URL.createObjectURL(file);
    nameEl.textContent = file.name;
    uploadingEl.classList.add('visible');
    uploading = true;

    try {
      const res = await fetch('/api/feedback/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'upload_failed');
      attachmentUrl = data.url;
      uploadingEl.classList.remove('visible');
      previewEl.classList.add('visible');
    } catch {
      clearAttachment();
      errorEl.textContent = 'Image upload failed — try again.';
      errorEl.classList.add('visible');
    } finally {
      uploading = false;
    }
  });

  // ── Submit ───────────────────────────────────────────────────────────────────
  overlay.querySelector('#fb-submit').addEventListener('click', async () => {
    const title = overlay.querySelector('#fb-title').value.trim();
    const message = overlay.querySelector('#fb-message').value.trim();
    if (!message) {
      overlay.querySelector('#fb-message').focus();
      return;
    }
    if (uploading) {
      window.toast?.('Image is still uploading — please wait a moment.');
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
        body: JSON.stringify({ title, message, category: selectedCategory, page_url: location.href, attachment_url: attachmentUrl }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'request failed');
      }

      close();
      window.toast?.success('Thanks for your feedback!');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Submit Feedback';
      window.toast?.error('Could not send feedback — please try again.');
    }
  });

  window.FeedbackWidget = { open, close };
})();

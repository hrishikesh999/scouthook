/* generate.js — idea input and submission for generate.html */

/* ── 1. DOM references ───────────────────────────────────────── */
const ideaInput          = document.getElementById('idea-input');
const ideaError          = document.getElementById('idea-error');
const generateBtn        = document.getElementById('generate-btn');
const voiceIndicator     = document.getElementById('voice-indicator-area');
const generatingState    = document.getElementById('generating-state');
const generateError      = document.getElementById('generate-error');
const charCount          = document.getElementById('idea-char-count');
const substanceWarning   = document.getElementById('substance-warning');
const substanceWarningTx = document.getElementById('substance-warning-text');
const generateBtnAnyway  = document.getElementById('generate-btn-anyway');

generateBtnAnyway?.addEventListener('click', () => triggerGenerate({ skipSubstanceCheck: true }));

/* ── 2. Auto-grow textarea + char counter ────────────────────── */
ideaInput.addEventListener('input', () => {
  ideaInput.style.height = 'auto';
  ideaInput.style.height = ideaInput.scrollHeight + 'px';
  clearError();
  updateCharCount();
});

function updateCharCount() {
  const len = ideaInput.value.length;
  if (len === 0) {
    charCount.textContent = '';
    charCount.className = 'gen-char-count';
    return;
  }
  if (len < 80) {
    charCount.textContent = `${len} / 80 characters minimum`;
    charCount.className = 'gen-char-count warn';
  } else {
    charCount.textContent = '';
    charCount.className = 'gen-char-count';
  }
}

/* ── 3. Voice profile indicator ─────────────────────────────── */
async function loadProfile() {
  try {
    const uid = getUserId();
    const res = await fetch(`/api/profile/${uid}`, { headers: apiHeaders() });
    const data = await res.json();
    const profile = data.profile;
    const complete = profile && profile.content_niche && profile.audience_role && profile.audience_pain;
    if (complete) {
      voiceIndicator.innerHTML = `<div class="voice-indicator"><span class="voice-indicator-dot voice-indicator-dot--green"></span><a href="/profile.html" class="edit-link">Created using your voice profile</a></div>`;
    } else {
      voiceIndicator.innerHTML = `<div class="voice-indicator"><span class="voice-indicator-dot voice-indicator-dot--red"></span><a href="/profile.html" class="edit-link">Voice profile incomplete, complete it for better results</a></div>`;
    }
  } catch {
    voiceIndicator.innerHTML = `<div class="voice-indicator"><span class="voice-indicator-dot voice-indicator-dot--red"></span><a href="/profile.html" class="edit-link">Voice profile incomplete, complete it for better results</a></div>`;
  }
}

/* ── 4. Generate ─────────────────────────────────────────────── */
generateBtn.addEventListener('click', () => triggerGenerate());

async function triggerGenerate(opts = {}) {
  clearError();

  const idea = ideaInput.value.trim();
  if (!idea) {
    showInputError('Add a thought before writing the post');
    ideaInput.focus();
    return;
  }
  if (idea.length < 80) {
    showInputError('Add more of your own words — a few sentences gives us more to work with.');
    ideaInput.focus();
    return;
  }

  setGenerating(true);

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 30000);

  try {
    const body = { path: 'idea', raw_idea: idea };
    if (opts.skipSubstanceCheck) body.skip_substance_check = true;

    const res = await fetch('/api/generate', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await res.json();

    if (!res.ok || !data.ok) {
      const err = new Error(data.error || 'Generation failed');
      if (data.error === 'plan_limit_exceeded') {
        err.planCurrent = data.current;
        err.planLimit   = data.limit;
      }
      if (data.error === 'missing_substance') {
        err.substancePrompt = data.prompt;
      }
      throw err;
    }

    window.location.href = `/preview.html?post_id=${encodeURIComponent(data.id)}`;

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      showGenerateError('This is taking too long. <a href="#">Try again →</a>');
    } else if (err.message === 'missing_substance') {
      showSubstanceWarning(err.substancePrompt || 'Add a specific outcome or contrarian view to improve this post.');
    } else if (err.message === 'complete_profile_first') {
      showGenerateError('Your voice profile is incomplete — posts need it to generate. <a href="/profile.html">Complete it →</a>');
    } else if (err.message === 'plan_limit_exceeded') {
      const used = (err.planCurrent !== undefined && err.planLimit !== undefined)
        ? ` You've used ${err.planCurrent} of ${err.planLimit} this month.` : '';
      showGenerateError(`You've reached the free plan generation limit.${used} <button type="button" onclick="window.PricingModal?.open()" style="background:none;border:none;padding:0;color:var(--brand);font-weight:600;cursor:pointer;font-size:inherit">Upgrade to Pro →</button>`);
    } else {
      showGenerateError('Something went wrong. <a href="#">Try again →</a>');
    }
    setGenerating(false);
  }}

function showSubstanceWarning(msg) {
  if (substanceWarning && substanceWarningTx) {
    substanceWarningTx.textContent = msg;
    substanceWarning.style.display = 'block';
  }
}

/* ── 5. UI helpers ───────────────────────────────────────────── */
function setGenerating(loading) {
  generateBtn.disabled    = loading;
  generateBtn.textContent = loading ? 'Writing the post…' : 'Write the post';
  generatingState.classList.toggle('visible', loading);
  if (loading) ideaInput.readOnly = true;
  else ideaInput.readOnly = false;
}

function showInputError(msg) {
  ideaInput.classList.add('error');
  ideaError.textContent = msg;
  ideaError.classList.add('visible');
}

function showGenerateError(html) {
  generateError.innerHTML = html;
  generateError.classList.add('visible');
  const tryLink = generateError.querySelector('a[href="#"]');
  if (tryLink) tryLink.addEventListener('click', (e) => { e.preventDefault(); triggerGenerate(); });
}

function clearError() {
  ideaInput.classList.remove('error');
  ideaError.classList.remove('visible');
  generateError.classList.remove('visible');
  if (substanceWarning) substanceWarning.style.display = 'none';
}

/* ── 6. Mode switcher ────────────────────────────────────────── */
const modeBtns = document.querySelectorAll('.gen-mode-btn');
const modePane = {
  idea:       document.getElementById('gen-pane-idea'),
  'from-doc': document.getElementById('gen-pane-from-doc'),
};

modeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    modeBtns.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    const mode = btn.dataset.mode;
    Object.entries(modePane).forEach(([m, el]) => { if (el) el.style.display = m === mode ? '' : 'none'; });
  });
});

/* ── 7. From-a-document pane ─────────────────────────────────── */
let fromDocFile    = null;
let fromDocVaultId = null; // vault_doc_id when picked from vault

function initFromDocPane() {
  const dropzone      = document.getElementById('gen-doc-dropzone');
  const fileInput     = document.getElementById('gen-doc-file-input');
  const fileBadge     = document.getElementById('gen-doc-file-badge');
  const fileName      = document.getElementById('gen-doc-file-name');
  const fileClear     = document.getElementById('gen-doc-file-clear');
  const urlInput      = document.getElementById('gen-doc-url');
  const genBtn        = document.getElementById('gen-doc-btn');
  const errEl         = document.getElementById('gen-doc-error');
  const pickerToggle  = document.getElementById('gen-vault-picker-toggle');
  const pickerPanel   = document.getElementById('gen-vault-picker');
  const pickerList    = document.getElementById('gen-vault-picker-list');

  const ACCEPTED_EXT = ['pdf', 'docx', 'txt'];
  let pickerLoaded = false;

  function showFile(file) {
    fromDocFile    = file;
    fromDocVaultId = null;
    fileName.textContent = file.name;
    fileBadge.hidden = false;
    dropzone.hidden  = true;
    if (urlInput) urlInput.value = '';
  }

  function showVaultDoc(id, name) {
    fromDocFile    = null;
    fromDocVaultId = id;
    fileName.textContent = name;
    fileBadge.hidden = false;
    dropzone.hidden  = true;
    if (urlInput) urlInput.value = '';
    // Close picker
    pickerPanel.hidden = true;
    pickerToggle.setAttribute('aria-expanded', 'false');
  }

  function clearFile() {
    fromDocFile    = null;
    fromDocVaultId = null;
    fileBadge.hidden = true;
    dropzone.hidden  = false;
    // Deselect any picker item
    pickerList.querySelectorAll('.gen-vault-picker-item').forEach(el => el.classList.remove('selected'));
  }

  function showErr(msg) { errEl.textContent = msg; errEl.style.display = ''; }
  function hideErr()     { errEl.style.display = 'none'; }

  function handleFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!ACCEPTED_EXT.includes(ext)) {
      showErr('Only PDF, DOCX, and TXT files are supported.');
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      showErr('File is too large. Maximum size is 25 MB.');
      return;
    }
    hideErr();
    showFile(file);
  }

  // Click / keyboard to browse
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });

  // Drag and drop
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragging'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragging');
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) handleFile(fileInput.files[0]);
    fileInput.value = '';
  });

  fileClear.addEventListener('click', clearFile);
  genBtn.addEventListener('click', runFromDocGeneration);

  // ── Vault picker ──
  pickerToggle.addEventListener('click', async () => {
    const isOpen = !pickerPanel.hidden;
    if (isOpen) {
      pickerPanel.hidden = true;
      pickerToggle.setAttribute('aria-expanded', 'false');
      return;
    }
    pickerPanel.hidden = false;
    pickerToggle.setAttribute('aria-expanded', 'true');

    if (pickerLoaded) return;
    pickerLoaded = true;

    try {
      const res  = await fetch('/api/vault/documents', { headers: apiHeaders() });
      const data = await res.json();
      const docs  = (data.documents || []).filter(d => d.status === 'ready');

      if (docs.length === 0) {
        pickerList.innerHTML = `<div class="gen-vault-picker-empty">No ready documents in your Vault yet. <a href="/vault.html" style="color:var(--brand)">Upload one →</a></div>`;
        return;
      }

      pickerList.innerHTML = docs.map(d => {
        const date = d.created_at ? new Date(d.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
        return `<button type="button" class="gen-vault-picker-item" data-id="${d.id}" data-name="${escapeAttr(d.filename)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span class="gen-vault-picker-item-name">${escapeHtml(d.filename)}</span>
          <span class="gen-vault-picker-item-date">${date}</span>
        </button>`;
      }).join('');

      pickerList.querySelectorAll('.gen-vault-picker-item').forEach(item => {
        item.addEventListener('click', () => {
          pickerList.querySelectorAll('.gen-vault-picker-item').forEach(el => el.classList.remove('selected'));
          item.classList.add('selected');
          showVaultDoc(item.dataset.id, item.dataset.name);
        });
      });
    } catch {
      pickerList.innerHTML = '<div class="gen-vault-picker-empty">Could not load documents. Try refreshing.</div>';
    }
  });
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

async function runFromDocGeneration() {
  const genBtn   = document.getElementById('gen-doc-btn');
  const statusEl = document.getElementById('gen-doc-status');
  const errEl    = document.getElementById('gen-doc-error');
  const urlInput = document.getElementById('gen-doc-url');
  const docUrl   = (urlInput?.value || '').trim();

  if (!fromDocFile && !docUrl && !fromDocVaultId) {
    errEl.textContent = 'Please upload a file, paste a URL, or pick from your Vault.';
    errEl.style.display = '';
    return;
  }
  if (docUrl && !/^https?:\/\//i.test(docUrl)) {
    errEl.textContent = 'Please enter a valid URL (starting with https://).';
    errEl.style.display = '';
    return;
  }

  errEl.style.display    = 'none';
  genBtn.disabled        = true;
  genBtn.textContent     = 'Extracting and generating…';
  statusEl.style.display = '';

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 90_000);

  try {
    let res;
    if (fromDocVaultId) {
      res = await fetch('/api/generate/from-doc', {
        method:  'POST',
        headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify({ vault_doc_id: fromDocVaultId }),
        signal:  controller.signal,
      });
    } else if (fromDocFile) {
      const extMime = {
        pdf:  'application/pdf',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        txt:  'text/plain',
      };
      const ext  = fromDocFile.name.split('.').pop().toLowerCase();
      const mime = fromDocFile.type || extMime[ext] || 'text/plain';
      const buf  = await fromDocFile.arrayBuffer();
      res = await fetch('/api/generate/from-doc', {
        method:  'POST',
        headers: { ...apiHeaders(), 'Content-Type': mime, 'X-Filename': encodeURIComponent(fromDocFile.name) },
        body:    buf,
        signal:  controller.signal,
      });
    } else {
      res = await fetch('/api/generate/from-doc', {
        method:  'POST',
        headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: docUrl }),
        signal:  controller.signal,
      });
    }

    clearTimeout(timeout);
    const data = await res.json();

    if (!res.ok || !data.ok) {
      const msg = data.error === 'plan_limit_exceeded'
        ? 'You\'ve reached your generation limit. <a href="/billing.html">Upgrade →</a>'
        : data.error === 'complete_profile_first'
        ? 'Complete your <a href="/profile.html">voice profile</a> first.'
        : data.error === 'doc_too_short'
        ? 'The document didn\'t have enough text to work with. Try a longer file or URL.'
        : data.error === 'url_fetch_failed'
        ? 'Couldn\'t fetch that URL. Try uploading the file directly.'
        : data.error === 'vault_doc_not_found'
        ? 'That document is no longer in your Vault. <a href="/vault.html">Manage Vault →</a>'
        : 'Something went wrong. Please try again.';
      errEl.innerHTML    = msg;
      errEl.style.display = '';
      return;
    }

    window.location.href = `/preview.html?post_id=${encodeURIComponent(data.id)}`;

  } catch (err) {
    clearTimeout(timeout);
    const msg = err.name === 'AbortError'
      ? 'Generation timed out. Please try again.'
      : 'Something went wrong. Please try again.';
    errEl.textContent   = msg;
    errEl.style.display = '';
  } finally {
    genBtn.disabled        = false;
    genBtn.textContent     = 'Extract and generate →';
    statusEl.style.display = 'none';
  }
}

/* ── 9. Init ─────────────────────────────────────────────────── */
(async function init() {
  await window.scouthookAuthReady;
  await loadProfile();
  initFromDocPane();

  // Auto-switch tab if ?mode=from-doc is in the URL
  const urlMode = new URLSearchParams(location.search).get('mode');
  if (urlMode === 'from-doc') {
    document.querySelector(`[data-mode="${urlMode}"]`)?.click();
  } else {
    ideaInput.focus();
  }
})();
